## Description

Simple CLI tool for use with Ollama AI api - Install from the dmg/exe.

The Tool uses the Ollama API in the background so check the connection and port is correct: `http://127.0.0.1:11434/api/generate`

## Use cases

> ✅ Tip:
> The CLI will be able to parse the following file formats:
> [txt (variants), md, pdf and docx]
> this can be extended if needed but stopped at the basic types

The CLI takes in 3 parameters

1 `--file` Files to use in your query

2 `--task` Which is the prompt passed to the api in Ollama what do you want it to do with the file

3 `--model` Which model to use (Note you need to know what models you have installed locally)

## Examples

```
node ollama_client.js --model mistral \
  --file "/Users/donaliai/Downloads/CV_2025.pdf" \
  --task "Summarise the document please are they suitable for a QA role"
```

```
node ollama_client.js --model mistral \
  --file "/Users/donaliai/Downloads/QA_Manager_FTC.docx" \
  --task "Summarise the document to pick out the key responsibilities for the role"
```
