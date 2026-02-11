#!/usr/bin/env node
/**
 * extract_archive.js - Extract a .fig file archive
 *
 * Modern .fig files are ZIP archives containing:
 *   canvas.fig  - kiwi-encoded design data
 *   meta.json   - file metadata
 *   thumbnail.png - preview
 *   images/     - embedded raster images (hash filenames)
 *
 * Usage: node extract_archive.js <input.fig> <output_dir>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const inputFile = process.argv[2];
const outputDir = process.argv[3] || '/tmp/figma_extract';

if (!inputFile) {
    console.error('Usage: node extract_archive.js <input.fig> <output_dir>');
    process.exit(1);
}

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

// Create output directory
fs.mkdirSync(outputDir, { recursive: true });

// Read file header to determine format
const buf = fs.readFileSync(inputFile);
const header = buf.slice(0, 4);

// Check if it's a ZIP file (PK\x03\x04)
if (header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04) {
    console.log('Detected ZIP format .fig file');
    // Use system unzip
    try {
        execSync(`unzip -o "${inputFile}" -d "${outputDir}"`, { stdio: 'pipe' });
    } catch (e) {
        // unzip may return non-zero even on success for some warnings
        // Check if canvas.fig was extracted
        if (!fs.existsSync(path.join(outputDir, 'canvas.fig'))) {
            console.error('Failed to extract .fig archive:', e.message);
            process.exit(1);
        }
    }
} else {
    // Raw fig-kiwi format (older .fig files) - just copy as canvas.fig
    console.log('Detected raw fig-kiwi format');
    fs.copyFileSync(inputFile, path.join(outputDir, 'canvas.fig'));
}

// Report what was extracted
console.log(`\nExtracted to: ${outputDir}`);
const files = [];
function listDir(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            listDir(fullPath, relPath);
        } else {
            const stat = fs.statSync(fullPath);
            files.push({ path: relPath, size: stat.size });
        }
    }
}
listDir(outputDir, '');

console.log('\nContents:');
files.forEach(f => {
    const sizeStr = f.size > 1024 * 1024
        ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
        : f.size > 1024
        ? `${(f.size / 1024).toFixed(1)} KB`
        : `${f.size} B`;
    console.log(`  ${f.path} (${sizeStr})`);
});

// Read meta.json if it exists
const metaPath = path.join(outputDir, 'meta.json');
if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    console.log(`\nFile name: ${meta.file_name || 'unknown'}`);
    if (meta.exported_at) console.log(`Exported at: ${meta.exported_at}`);
}

// Count images
const imagesDir = path.join(outputDir, 'images');
if (fs.existsSync(imagesDir)) {
    const imageFiles = fs.readdirSync(imagesDir);
    console.log(`\nEmbedded images: ${imageFiles.length}`);
}

console.log('\nDone. Next step: node decode_kiwi.js ' + path.join(outputDir, 'canvas.fig') + ' /tmp/figma_message.json');
