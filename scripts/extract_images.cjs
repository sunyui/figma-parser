#!/usr/bin/env node
/**
 * extract_images.js - Map image hashes in fills to extracted image files
 *
 * Reads decoded Figma message JSON, finds all IMAGE fill paints, converts
 * their hash arrays to hex strings, and maps them to files in the images/ dir.
 *
 * Usage: node extract_images.js <message.json> [images_dir]
 */

const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || '/tmp/figma_message.json';
const imagesDir = process.argv[3] || '/tmp/figma_extract/images';

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const nodes = data.nodeChanges;

function hashToHex(hash) {
    if (!hash) return null;
    // hash can be an Array or an Object with numeric keys {0: byte, 1: byte, ...}
    let hex = '';
    for (let i = 0; i < 20; i++) {
        const byte = hash[i];
        if (byte === undefined) break;
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex || null;
}

console.log('=== IMAGE NODE -> FILE MAPPING ===\n');

const mapping = [];
nodes.forEach(n => {
    if (n.fillPaints) {
        n.fillPaints.forEach(p => {
            if (p.type === 'IMAGE' && p.image && p.image.hash) {
                const hex = hashToHex(p.image.hash);
                if (!hex) return; // skip if hash can't be converted
                const pos = n.transform ? `x=${Math.round(n.transform.m02)}, y=${Math.round(n.transform.m12)}` : 'N/A';
                const size = n.size ? `${Math.round(n.size.x)}x${Math.round(n.size.y)}` : 'N/A';
                const filePath = path.join(imagesDir, hex);
                const exists = fs.existsSync(filePath);

                const entry = {
                    nodeName: n.name,
                    nodeType: n.type,
                    guid: n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null,
                    size,
                    position: pos,
                    imageHash: hex,
                    fileExists: exists,
                    fileSize: exists ? fs.statSync(filePath).size : 0
                };
                mapping.push(entry);

                console.log(`Node: "${n.name}" (${n.type})`);
                console.log(`  Hash: ${hex}`);
                console.log(`  Size: ${size}, Position: ${pos}`);
                console.log(`  File: ${exists ? `exists (${entry.fileSize} bytes)` : 'NOT FOUND'}`);
                console.log('');
            }
        });
    }
});

// List all image files and mark unused ones
if (fs.existsSync(imagesDir)) {
    const usedHashes = new Set(mapping.map(m => m.imageHash));
    const allFiles = fs.readdirSync(imagesDir);

    console.log('=== ALL IMAGE FILES ===');
    allFiles.forEach(f => {
        const stat = fs.statSync(path.join(imagesDir, f));
        const used = usedHashes.has(f);
        console.log(`${f} (${stat.size} bytes) ${used ? '- USED' : '- UNUSED'}`);
    });

    const unused = allFiles.filter(f => !usedHashes.has(f));
    if (unused.length > 0) {
        console.log(`\nNote: ${unused.length} image files not referenced by any node fill.`);
        console.log('These may be thumbnails, old versions, or referenced by other means.');
    }
}

// Write mapping JSON
const outputFile = inputFile.replace('.json', '_images.json');
fs.writeFileSync(outputFile, JSON.stringify(mapping, null, 2));
console.log(`\nMapping saved to: ${outputFile}`);
