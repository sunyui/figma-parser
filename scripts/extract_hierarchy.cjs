#!/usr/bin/env node
/**
 * extract_hierarchy.js - Generate a human-readable tree of the Figma node hierarchy
 *
 * Produces an indented text file showing the visual structure with key properties:
 * type, name, size, position, fills, corner radius, opacity, text content, effects.
 *
 * Usage: node extract_hierarchy.js <message.json> <output.txt> [maxDepth]
 */

const fs = require('fs');

const inputFile = process.argv[2] || '/tmp/figma_message.json';
const outputFile = process.argv[3] || '/tmp/figma_tree.txt';
const maxDepth = parseInt(process.argv[4] || '8', 10);

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const nodes = data.nodeChanges;

function colorToHex(c) {
    if (!c) return null;
    const r = Math.round((c.r || 0) * 255);
    const g = Math.round((c.g || 0) * 255);
    const b = Math.round((c.b || 0) * 255);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Build lookup maps
const nodeMap = {};
const childrenMap = {};
nodes.forEach(n => {
    const key = n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null;
    if (key) nodeMap[key] = n;
    if (n.parentIndex && n.parentIndex.guid) {
        const parentKey = `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}`;
        if (!childrenMap[parentKey]) childrenMap[parentKey] = [];
        childrenMap[parentKey].push(n);
    }
});

// Find top-level canvas and its children
const canvas = nodes.find(n => n.type === 'CANVAS');
const canvasKey = canvas ? `${canvas.guid.sessionID}:${canvas.guid.localID}` : null;
const topFrames = childrenMap[canvasKey] || [];

function getNodeInfo(n, indent) {
    const prefix = '  '.repeat(indent);
    let info = `${prefix}[${n.type}] "${n.name}"`;
    if (n.size) info += ` ${Math.round(n.size.x)}x${Math.round(n.size.y)}`;
    if (n.transform) info += ` @(${Math.round(n.transform.m02)},${Math.round(n.transform.m12)})`;
    if (n.stackMode) {
        info += ` stack=${n.stackMode}`;
        if (n.stackSpacing !== undefined) info += ` gap=${n.stackSpacing}`;
    }
    if (n.itemSpacing !== undefined && !n.stackMode) info += ` itemSpacing=${n.itemSpacing}`;
    if (n.paddingLeft !== undefined || n.paddingTop !== undefined) {
        info += ` pad=[${n.paddingTop || 0},${n.paddingRight || 0},${n.paddingBottom || 0},${n.paddingLeft || 0}]`;
    }
    if (n.fillPaints && n.fillPaints.length > 0) {
        const fillStr = n.fillPaints.map(p => {
            if (p.type === 'SOLID' && p.color) return colorToHex(p.color);
            if (p.type === 'IMAGE') return 'IMG';
            if (p.type && p.type.includes('GRADIENT')) return p.type;
            return p.type || '?';
        }).join(',');
        info += ` fill=[${fillStr}]`;
    }
    if (n.cornerRadius) info += ` r=${n.cornerRadius}`;
    if (n.opacity !== undefined && n.opacity !== 1) info += ` opacity=${n.opacity.toFixed(2)}`;
    if (n.visible === false) info += ' HIDDEN';
    if (n.type === 'TEXT' && n.textData) {
        info += ` "${(n.textData.characters || '').substring(0, 60)}"`;
        if (n.fontSize) info += ` ${n.fontSize}px`;
        if (n.fontWeight) info += ` w${n.fontWeight}`;
        if (n.lineHeight) info += ` lh=${JSON.stringify(n.lineHeight)}`;
    }
    if (n.effects && n.effects.length > 0) {
        info += ` fx=[${n.effects.map(e => e.type).join(',')}]`;
    }
    return info;
}

const output = [];
function printTree(n, indent, depth) {
    if (indent > depth) {
        const key = n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null;
        const cc = key ? (childrenMap[key] || []).length : 0;
        if (cc > 0) output.push('  '.repeat(indent) + `... (${cc} children)`);
        return;
    }
    output.push(getNodeInfo(n, indent));
    const key = n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null;
    const children = key ? (childrenMap[key] || []) : [];
    children.sort((a, b) => {
        const pa = a.parentIndex ? a.parentIndex.position : '';
        const pb = b.parentIndex ? b.parentIndex.position : '';
        return (pa || '').localeCompare(pb || '');
    });
    children.forEach(child => printTree(child, indent + 1, depth));
}

topFrames.forEach(frame => {
    printTree(frame, 0, maxDepth);
    output.push('');
});

fs.writeFileSync(outputFile, output.join('\n'));
console.log(`Tree written to ${outputFile} (${output.length} lines, max depth ${maxDepth})`);
