#!/usr/bin/env node
/**
 * extract_layout.js - Extract flat layout data from decoded Figma JSON
 *
 * Reads the full decoded message JSON and produces a simplified flat array
 * of all nodes with their visual properties: position, size, fills, strokes,
 * effects, text data, corner radii, auto-layout, opacity, visibility.
 *
 * Usage: node extract_layout.js <message.json> <output.json>
 */

const fs = require('fs');

const inputFile = process.argv[2] || '/tmp/figma_message.json';
const outputFile = process.argv[3] || '/tmp/figma_layout.json';

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

console.log(`Reading: ${inputFile}`);
const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const nodes = data.nodeChanges;

if (!nodes || !nodes.length) {
    console.error('No nodeChanges found in input');
    process.exit(1);
}

function colorToHex(c) {
    if (!c) return null;
    const r = Math.round((c.r || 0) * 255);
    const g = Math.round((c.g || 0) * 255);
    const b = Math.round((c.b || 0) * 255);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function colorToRgba(c) {
    if (!c) return null;
    const r = Math.round((c.r || 0) * 255);
    const g = Math.round((c.g || 0) * 255);
    const b = Math.round((c.b || 0) * 255);
    const a = c.a !== undefined ? c.a : 1;
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

function hashToHex(hash) {
    if (!hash || !Array.isArray(hash)) return null;
    let hex = '';
    for (let i = 0; i < hash.length && i < 20; i++) {
        hex += hash[i].toString(16).padStart(2, '0');
    }
    return hex;
}

const output = [];
nodes.forEach(n => {
    const entry = {
        name: n.name,
        type: n.type,
        guid: n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null,
    };

    // Size
    if (n.size) entry.size = { w: Math.round(n.size.x), h: Math.round(n.size.y) };

    // Transform -> position
    if (n.transform) {
        entry.position = { x: Math.round(n.transform.m02), y: Math.round(n.transform.m12) };
    }

    // Parent
    if (n.parentIndex && n.parentIndex.guid) {
        entry.parentGuid = `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}`;
    }

    // Fills
    if (n.fillPaints && n.fillPaints.length > 0) {
        entry.fills = n.fillPaints.map(p => {
            const fill = { type: p.type };
            if (p.color) fill.color = colorToHex(p.color);
            if (p.opacity !== undefined) fill.opacity = p.opacity;
            if (p.image && p.image.hash) fill.imageHash = hashToHex(p.image.hash);
            if (p.gradientStops) {
                fill.gradientStops = p.gradientStops.map(s => ({
                    color: colorToRgba(s.color),
                    position: s.position
                }));
            }
            if (p.gradientTransform) fill.gradientTransform = p.gradientTransform;
            return fill;
        });
    }

    // Corner radius
    if (n.cornerRadius !== undefined) entry.cornerRadius = n.cornerRadius;
    if (n.rectangleCornerRadii) entry.cornerRadii = n.rectangleCornerRadii;

    // Auto-layout / stack
    if (n.stackMode) entry.stackMode = n.stackMode;
    if (n.stackSpacing !== undefined) entry.stackSpacing = n.stackSpacing;
    if (n.stackPadding) entry.stackPadding = n.stackPadding;
    if (n.stackPrimaryAlignItems !== undefined) entry.stackPrimaryAlign = n.stackPrimaryAlignItems;
    if (n.stackCounterAlignItems !== undefined) entry.stackCounterAlign = n.stackCounterAlignItems;
    if (n.horizontalPadding !== undefined) entry.horizontalPadding = n.horizontalPadding;
    if (n.verticalPadding !== undefined) entry.verticalPadding = n.verticalPadding;
    if (n.paddingLeft !== undefined) entry.paddingLeft = n.paddingLeft;
    if (n.paddingRight !== undefined) entry.paddingRight = n.paddingRight;
    if (n.paddingTop !== undefined) entry.paddingTop = n.paddingTop;
    if (n.paddingBottom !== undefined) entry.paddingBottom = n.paddingBottom;
    if (n.itemSpacing !== undefined) entry.itemSpacing = n.itemSpacing;

    // Effects
    if (n.effects && n.effects.length > 0) {
        entry.effects = n.effects.map(e => {
            const eff = { type: e.type };
            if (e.color) eff.color = colorToRgba(e.color);
            if (e.offset) eff.offset = e.offset;
            if (e.radius !== undefined) eff.radius = e.radius;
            if (e.spread !== undefined) eff.spread = e.spread;
            return eff;
        });
    }

    // Strokes
    if (n.strokePaints && n.strokePaints.length > 0) {
        entry.strokes = n.strokePaints.map(p => ({
            type: p.type,
            color: p.color ? colorToHex(p.color) : null
        }));
    }
    if (n.strokeWeight !== undefined) entry.strokeWeight = n.strokeWeight;

    // Text data
    if (n.type === 'TEXT' && n.textData) {
        entry.text = n.textData.characters ? n.textData.characters.substring(0, 200) : '';
        if (n.fontSize) entry.fontSize = n.fontSize;
        if (n.fontFamily) entry.fontFamily = n.fontFamily;
        if (n.fontWeight !== undefined) entry.fontWeight = n.fontWeight;
        if (n.lineHeight) entry.lineHeight = n.lineHeight;
        if (n.letterSpacing) entry.letterSpacing = n.letterSpacing;
        if (n.textData.fontName) entry.fontName = n.textData.fontName;
        // Styled text segments
        if (n.textData.glyphs && n.textData.glyphs.length > 0) {
            const segments = [];
            let lastStyle = null;
            n.textData.glyphs.forEach(g => {
                const style = {
                    fontSize: g.fontSize,
                    fontFamily: g.fontFamily,
                    fontWeight: g.fontWeight,
                    fillColor: g.fillPaints ? g.fillPaints.map(p => colorToHex(p.color)).join(',') : null
                };
                const key = JSON.stringify(style);
                if (key !== lastStyle) {
                    segments.push(style);
                    lastStyle = key;
                }
            });
            if (segments.length > 1) entry.textSegments = segments;
        }
    }

    // Opacity
    if (n.opacity !== undefined && n.opacity !== 1) entry.opacity = n.opacity;

    // Visibility
    if (n.visible === false) entry.visible = false;

    // Clips content
    if (n.clipsContent !== undefined) entry.clipsContent = n.clipsContent;

    output.push(entry);
});

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
console.log(`Extracted ${output.length} nodes to ${outputFile}`);

// Summary statistics
const types = {};
output.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
console.log('\nNode types:');
Object.entries(types).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
});

// Image usage
let imageCount = 0;
output.forEach(n => {
    if (n.fills) n.fills.forEach(f => { if (f.imageHash) imageCount++; });
});
console.log(`\nImage fills: ${imageCount}`);
