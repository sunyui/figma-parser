#!/usr/bin/env node
/**
 * extract_gradients.js - Extract gradient and effect details from Figma data
 *
 * Finds all gradient fills (LINEAR, RADIAL, ANGULAR) and visual effects
 * (DROP_SHADOW, INNER_SHADOW, BLUR, FOREGROUND_BLUR) with full parameters.
 *
 * Usage: node extract_gradients.js <message.json>
 */

const fs = require('fs');

const inputFile = process.argv[2] || '/tmp/figma_message.json';

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const nodes = data.nodeChanges;

function colorToRgba(c) {
    if (!c) return null;
    const r = Math.round((c.r || 0) * 255);
    const g = Math.round((c.g || 0) * 255);
    const b = Math.round((c.b || 0) * 255);
    const a = c.a !== undefined ? c.a : 1;
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

// Gradients
console.log('=== GRADIENT DETAILS ===\n');
const gradients = [];
nodes.forEach(n => {
    if (n.fillPaints) {
        n.fillPaints.forEach(p => {
            if (p.type && p.type.includes('GRADIENT')) {
                const size = n.size ? `${Math.round(n.size.x)}x${Math.round(n.size.y)}` : 'N/A';
                const pos = n.transform ? `@(${Math.round(n.transform.m02)},${Math.round(n.transform.m12)})` : '';
                console.log(`"${n.name}" (${n.type}) ${size} ${pos}`);
                console.log(`  Gradient type: ${p.type}`);
                if (p.gradientStops) {
                    p.gradientStops.forEach(s => {
                        console.log(`  stop: ${colorToRgba(s.color)} at ${(s.position * 100).toFixed(1)}%`);
                    });
                }
                if (p.gradientTransform) {
                    const t = p.gradientTransform;
                    console.log(`  transform: [[${t.m00?.toFixed(3)}, ${t.m01?.toFixed(3)}, ${t.m02?.toFixed(3)}], [${t.m10?.toFixed(3)}, ${t.m11?.toFixed(3)}, ${t.m12?.toFixed(3)}]]`);
                }
                console.log('');

                gradients.push({
                    nodeName: n.name,
                    nodeType: n.type,
                    guid: n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null,
                    gradientType: p.type,
                    stops: p.gradientStops ? p.gradientStops.map(s => ({
                        color: colorToRgba(s.color),
                        position: s.position
                    })) : [],
                    transform: p.gradientTransform || null
                });
            }
        });
    }
});

// Effects
console.log('\n=== ALL EFFECTS ===\n');
const effects = [];
nodes.forEach(n => {
    if (n.effects && n.effects.length > 0) {
        const size = n.size ? `${Math.round(n.size.x)}x${Math.round(n.size.y)}` : 'N/A';
        console.log(`"${n.name}" (${n.type}) ${size}:`);
        n.effects.forEach(e => {
            let desc = `  ${e.type}`;
            if (e.color) desc += ` color=${colorToRgba(e.color)}`;
            if (e.offset) desc += ` offset=(${e.offset.x},${e.offset.y})`;
            if (e.radius !== undefined) desc += ` radius=${e.radius}`;
            if (e.spread !== undefined) desc += ` spread=${e.spread}`;
            console.log(desc);

            effects.push({
                nodeName: n.name,
                nodeType: n.type,
                guid: n.guid ? `${n.guid.sessionID}:${n.guid.localID}` : null,
                effectType: e.type,
                color: e.color ? colorToRgba(e.color) : null,
                offset: e.offset || null,
                radius: e.radius,
                spread: e.spread
            });
        });
        console.log('');
    }
});

console.log(`\nTotal: ${gradients.length} gradients, ${effects.length} effects`);
