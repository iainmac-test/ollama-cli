#!/usr/bin/env node
// Direct Ollama client — supports .md/.txt/.json, .docx (mammoth), and .pdf (pdf-parse).
// Node 18+ required (global fetch).
const fs = require('node:fs');
const path = require('node:path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

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

// ---- Helpers ----
async function readAsText(absPath) {
  const lower = absPath.toLowerCase();
  if (lower.endsWith('.docx')) {
    // Word documents
    const { value } = await mammoth.extractRawText({ path: absPath });
    return value || '';
  } else if (lower.endsWith('.pdf')) {
    // PDFs (text-based; scanned PDFs need OCR first)
    const data = fs.readFileSync(absPath);
    const { text } = await pdfParse(data);
    return text || '';
  } else {
    // Plain text / markdown / json, etc.
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

// ---- Main ----
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
          '  • --file /path/to/doc (repeatable; supports .docx, .pdf, .md, .txt)\n' +
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
