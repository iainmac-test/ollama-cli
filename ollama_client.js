#!/usr/bin/env node
// Direct Ollama client — supports .md/.txt/.json, .docx (mammoth), .pdf (pdf-parse), and .pptx (zip+XML).
// Node 18+ required (global fetch).

const fs = require('node:fs');
const path = require('node:path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const unzipper = require('unzipper');
const { XMLParser } = require('fast-xml-parser');

const OLLAMA_URL =
  process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i !== -1 && i < args.length - 1) return args[i + 1];
  return fallback;
};

// Inputs
let model = getArg('--model') || args[0] || 'mistral';
let prompt = getArg('--prompt');
const task = getArg('--task');
const stream = has('--stream');

// Support multiple --file flags
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && i + 1 < args.length) files.push(args[i + 1]);
}

// ---------------- PPTX extraction ----------------
async function extractTextFromPptx(absPath) {
  const dir = await unzipper.Open.file(absPath);
  const slides = dir.files
    .filter(
      (f) => f.path.startsWith('ppt/slides/slide') && f.path.endsWith('.xml')
    )
    .sort((a, b) => {
      const na = parseInt(a.path.match(/slide(\d+)\.xml$/)?.[1] || '0', 10);
      const nb = parseInt(b.path.match(/slide(\d+)\.xml$/)?.[1] || '0', 10);
      return na - nb;
    });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    // keep tag names like 'a:t'
    preserveOrder: false,
  });

  // Recursively collect all <a:t> text nodes
  const collectText = (node, lines) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) collectText(n, lines);
      return;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (k === 'a:t') {
          if (typeof v === 'string') lines.push(v);
          else if (v != null) lines.push(String(v));
        } else {
          collectText(v, lines);
        }
      }
    }
  };

  const out = [];
  for (let idx = 0; idx < slides.length; idx++) {
    const slide = slides[idx];
    const buf = await slide.buffer();
    const xml = buf.toString('utf8');
    const js = parser.parse(xml);
    const lines = [];
    collectText(js, lines);

    const text = lines
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');

    out.push(`-- Slide ${idx + 1} --\n${text}`);
  }

  return out.join('\n\n');
}

// ---------------- Generic readers ----------------
async function readAsText(absPath) {
  const lower = absPath.toLowerCase();
  if (lower.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ path: absPath });
    return value || '';
  } else if (lower.endsWith('.pdf')) {
    const data = fs.readFileSync(absPath);
    const { text } = await pdfParse(data);
    return text || '';
  } else if (lower.endsWith('.pptx')) {
    return await extractTextFromPptx(absPath);
  } else {
    // .md, .txt, .json, etc.
    return fs.readFileSync(absPath, 'utf8');
  }
}

async function readFilesCombined(filePaths) {
  const parts = [];
  for (const f of filePaths) {
    const abs = path.resolve(process.cwd(), f);
    if (!fs.existsSync(abs)) {
      console.error(`File not found: ${abs}`);
      process.exit(1);
    }
    try {
      const content = await readAsText(abs);
      parts.push(`### ${path.basename(abs)}\n${content}`);
    } catch (err) {
      console.error(`Failed to read ${abs}: ${err.message}`);
      process.exit(1);
    }
  }
  return parts.join('\n\n');
}

// ---------------- Ollama calls ----------------
async function callOnce({ model, prompt }) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error(`Ollama request failed ${res.status}: ${txt}`);
    process.exit(1);
  }
  const data = await res.json();
  process.stdout.write((data.response || '').trim() + '\n');
}

async function callStream({ model, prompt }) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error(`Ollama request failed ${res.status}: ${txt}`);
    process.exit(1);
  }
  for await (const chunk of res.body) {
    const text = chunk.toString('utf8').trim();
    if (!text) continue;
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        if (obj.response) process.stdout.write(obj.response);
        if (obj.done) {
          process.stdout.write('\n');
          return;
        }
      } catch {
        // ignore non-JSON
      }
    }
  }
}

// ---------------- Main ----------------
(async () => {
  try {
    let combinedText = '';
    if (files.length > 0) {
      combinedText = await readFilesCombined(files);
    }

    // Prompt precedence: --prompt > combined file text > positional text after model
    if (!prompt) {
      if (combinedText.trim()) {
        prompt = combinedText;
      } else if (args.length >= 2) {
        prompt = args.slice(1).join(' ');
      }
    }

    // Optional task prepended so the model knows what to do
    if (task && prompt) {
      prompt = `${task.trim()}\n\n${prompt}`;
    }

    if (!prompt || !prompt.trim()) {
      console.error(
        'No prompt text found.\n' +
          'Provide one of:\n' +
          '  • --prompt "Summarise this"\n' +
          '  • --file /path/to/doc (repeatable; supports .docx, .pdf, .pptx, .md, .txt)\n' +
          'Optional:\n' +
          '  • --task "Summarise into key points and action items"\n'
      );
      process.exit(1);
    }

    if (stream) await callStream({ model, prompt });
    else await callOnce({ model, prompt });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('ECONNREFUSED')) {
      console.error(
        'Connection refused. Ensure Ollama is running:\n' +
          '  • Open the Ollama UI app  OR  run `ollama serve`\n' +
          `  • Verify: curl ${OLLAMA_URL.replace(
            '/api/generate',
            ''
          )}/api/tags\n`
      );
    } else if (msg.includes('fetch is not defined')) {
      console.error('This script requires Node 18+ (global fetch).');
    } else {
      console.error(msg);
    }
    process.exit(1);
  }
})();
