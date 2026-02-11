#!/usr/bin/env node
/**
 * decode_kiwi.js - Decode a canvas.fig (fig-kiwi binary) into JSON
 *
 * The canvas.fig file has the fig-kiwi binary format:
 *   [8 bytes]  Header prelude "fig-kiwi"
 *   [4 bytes]  Version (uint32 LE)
 *   [4 bytes]  Chunk 0 size -> deflate-raw compressed kiwi schema
 *   [N bytes]  Chunk 0 data
 *   [4 bytes]  Chunk 1 size -> zstd or deflate-raw compressed kiwi message
 *   [N bytes]  Chunk 1 data
 *
 * Note: Newer .fig files (version >= ~100) use zstd compression for the
 * message chunk. The zstd magic number is 0xFD2FB528 (bytes: 28 B5 2F FD).
 * Older files use deflate-raw for both chunks.
 *
 * Uses: kiwi-schema (decode binary schema + compile + decode message)
 *       pako (deflate-raw decompression)
 *       fzstd (zstd decompression, for newer .fig files)
 *
 * Usage: node decode_kiwi.cjs <canvas.fig> <output.json>
 *
 * Prerequisites: npm install kiwi-schema pako fzstd
 */

const fs = require('fs');
const { decodeBinarySchema, compileSchema } = require('kiwi-schema');
const pako = require('pako');

let fzstd;
try { fzstd = require('fzstd'); } catch (e) { /* optional */ }

const FIG_KIWI_PRELUDE = 'fig-kiwi'; // 8 bytes
const ZSTD_MAGIC = 0xFD2FB528;

const inputFile = process.argv[2] || '/tmp/figma_extract/canvas.fig';
const outputFile = process.argv[3] || '/tmp/figma_message.json';

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

console.log(`Reading: ${inputFile}`);
const data = fs.readFileSync(inputFile);
const buf = new Uint8Array(data);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

// Verify prelude
const prelude = new TextDecoder().decode(buf.slice(0, FIG_KIWI_PRELUDE.length));
if (prelude !== FIG_KIWI_PRELUDE) {
    console.error(`Invalid prelude: "${prelude}" (expected "${FIG_KIWI_PRELUDE}")`);
    process.exit(1);
}

const version = dv.getUint32(FIG_KIWI_PRELUDE.length, true);
console.log(`Version: ${version}`);

// Read chunks starting after prelude (8) + version (4) = offset 12
let offset = FIG_KIWI_PRELUDE.length + 4;
const chunks = [];
while (offset + 4 < buf.length) {
    const size = dv.getUint32(offset, true);
    offset += 4;
    if (offset + size > buf.length) {
        console.error(`Chunk size ${size} exceeds remaining data (${buf.length - offset} bytes)`);
        break;
    }
    chunks.push(buf.slice(offset, offset + size));
    offset += size;
}

console.log(`Chunks: ${chunks.length} (sizes: ${chunks.map(c => c.length).join(', ')})`);

if (chunks.length < 2) {
    console.error('Expected at least 2 chunks (schema + data)');
    process.exit(1);
}

// Decompress schema (chunk 0) - always deflate-raw
console.log(`Schema chunk: ${chunks[0].length} bytes compressed`);
const schemaRaw = pako.inflateRaw(chunks[0]);
console.log(`Schema decompressed: ${schemaRaw.length} bytes`);

// Decode and compile schema
const schema = decodeBinarySchema(schemaRaw);
const compiled = compileSchema(schema);
console.log(`Schema definitions: ${schema.definitions?.length || 0}`);

// Decompress message (chunk 1) - zstd or deflate-raw
console.log(`Message chunk: ${chunks[1].length} bytes compressed`);

function isZstd(chunk) {
    if (chunk.length < 4) return false;
    const magic = (chunk[0]) | (chunk[1] << 8) | (chunk[2] << 16) | (chunk[3] << 24);
    return (magic >>> 0) === ZSTD_MAGIC;
}

let messageRaw;
if (isZstd(chunks[1])) {
    if (!fzstd) {
        console.error('Message chunk is zstd-compressed but fzstd is not installed.');
        console.error('Run: npm install fzstd');
        process.exit(1);
    }
    messageRaw = fzstd.decompress(chunks[1]);
    console.log(`Message decompressed (zstd): ${messageRaw.length} bytes`);
} else {
    messageRaw = pako.inflateRaw(chunks[1]);
    console.log(`Message decompressed (deflate-raw): ${messageRaw.length} bytes`);
}

// Decode message
const message = compiled.decodeMessage(messageRaw);
console.log(`Top-level keys: ${Object.keys(message)}`);

if (message.nodeChanges) {
    console.log(`Node count: ${message.nodeChanges.length}`);
}

// Write output
const json = JSON.stringify(message, null, 2);
fs.writeFileSync(outputFile, json);
console.log(`\nOutput: ${outputFile} (${(json.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`\nNext step: node extract_layout.cjs ${outputFile} /tmp/figma_layout.json`);
