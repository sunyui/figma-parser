#!/usr/bin/env node
/**
 * extract_vectors.cjs - Identify vector/icon nodes with full subtree analysis
 *
 * Finds icon containers (small FRAMEs with vector children), recursively
 * traverses their subtrees to identify all component shapes, extracts the
 * primary icon color, and outputs a complete icon inventory.
 *
 * Key improvements over naive single-level detection:
 * - Recursively traverses nested BOOLEAN_OPERATION / FRAME / GROUP layers
 * - Extracts primary color from the topmost BOOLEAN_OPERATION fill (not VECTOR)
 * - Ignores transparent background ROUNDED_RECTANGLEs (opacity ≈ 0)
 * - Reports full subtree structure for offline SVG reconstruction
 * - Outputs JSON manifest (--json flag) for use by export_icons.py
 *
 * Usage:
 *   node extract_vectors.cjs <message.json> [--json] [--output <path>]
 *
 * Examples:
 *   node extract_vectors.cjs /tmp/figma_message.json
 *   node extract_vectors.cjs /tmp/figma_message.json --json --output /tmp/icon_inventory.json
 */

const fs = require('fs');

// Parse args
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const outputIdx = args.indexOf('--output');
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
const inputFile = args.find(a => !a.startsWith('--') && (outputIdx < 0 || a !== args[outputIdx + 1]))
  || '/tmp/figma_message.json';

if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const nodes = data.nodeChanges;

// ── Helpers ──

function colorToHex(c) {
  if (!c) return null;
  const r = Math.round((c.r || 0) * 255);
  const g = Math.round((c.g || 0) * 255);
  const b = Math.round((c.b || 0) * 255);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function guidKey(g) {
  return g ? `${g.sessionID}:${g.localID}` : null;
}

function isTransparentBg(n) {
  // Background ROUNDED_RECTANGLEs have near-zero opacity (≈0.0001)
  return n.type === 'ROUNDED_RECTANGLE'
    && n.opacity !== undefined
    && n.opacity < 0.01;
}

function isVisualNode(n) {
  return ['VECTOR', 'BOOLEAN_OPERATION', 'ELLIPSE', 'ROUNDED_RECTANGLE', 'STAR', 'LINE', 'REGULAR_POLYGON'].includes(n.type);
}

// ── Build lookup maps ──

const nodeMap = {};
const childrenMap = {};

nodes.forEach(n => {
  const key = guidKey(n.guid);
  if (key) nodeMap[key] = n;
  if (n.parentIndex && n.parentIndex.guid) {
    const parentKey = guidKey(n.parentIndex.guid);
    if (!childrenMap[parentKey]) childrenMap[parentKey] = [];
    childrenMap[parentKey].push(n);
  }
});

// ── Recursive subtree analysis ──

/**
 * Recursively collect all descendant VECTOR nodes from a subtree.
 * Returns array of { guid, name, type, size, position, fills, strokes, hasBlob }
 */
function collectVectors(key, depth) {
  const n = nodeMap[key];
  if (!n) return [];
  const results = [];

  if (n.type === 'VECTOR') {
    results.push({
      guid: key,
      name: n.name || '',
      type: n.type,
      size: n.size ? { w: Math.round(n.size.x), h: Math.round(n.size.y) } : null,
      position: n.transform ? { x: Math.round(n.transform.m02), y: Math.round(n.transform.m12) } : null,
      fills: (n.fillPaints || []).map(p => p.color ? colorToHex(p.color) : p.type),
      strokes: (n.strokePaints || []).map(p => p.color ? colorToHex(p.color) : p.type),
      hasBlob: !!n.vectorNetworkBlob,
      depth
    });
  }

  // Recurse into children
  const children = childrenMap[key] || [];
  children.forEach(c => {
    const ck = guidKey(c.guid);
    if (ck) results.push(...collectVectors(ck, depth + 1));
  });

  return results;
}

/**
 * Build a tree description of all shapes in an icon subtree.
 * Returns { type, name, guid, size, position, fills, strokes, opacity, children }
 */
function buildShapeTree(key, depth) {
  const n = nodeMap[key];
  if (!n) return null;

  // Skip transparent background rectangles
  if (isTransparentBg(n)) return null;

  const node = {
    type: n.type,
    name: n.name || '',
    guid: key,
    size: n.size ? { w: Math.round(n.size.x), h: Math.round(n.size.y) } : null,
    position: n.transform ? { x: Math.round(n.transform.m02), y: Math.round(n.transform.m12) } : null,
    fills: (n.fillPaints || []).filter(p => p.color).map(p => ({
      color: colorToHex(p.color),
      opacity: p.opacity !== undefined ? p.opacity : 1
    })),
    strokes: (n.strokePaints || []).filter(p => p.color).map(p => ({
      color: colorToHex(p.color),
      width: n.strokeWeight || 1
    })),
    opacity: n.opacity !== undefined ? n.opacity : 1,
    hasBlob: !!n.vectorNetworkBlob,
    children: []
  };

  const children = childrenMap[key] || [];
  children.forEach(c => {
    const ck = guidKey(c.guid);
    if (ck) {
      const child = buildShapeTree(ck, depth + 1);
      if (child) node.children.push(child);
    }
  });

  return node;
}

/**
 * Extract the primary icon color from the shape tree.
 * Priority: topmost BOOLEAN_OPERATION fill > first VECTOR fill > first VECTOR stroke
 * For stroke-only icons (no fill or transparent fill), use stroke color.
 */
function extractPrimaryColor(shapeTree) {
  if (!shapeTree) return null;

  // If this is a BOOLEAN_OPERATION with a non-container fill, use it
  if (shapeTree.type === 'BOOLEAN_OPERATION' && shapeTree.fills.length > 0) {
    return shapeTree.fills[0].color;
  }

  // If this is a VECTOR with a fill (and the fill is not the same as the container bg), use it
  if (shapeTree.type === 'VECTOR' && shapeTree.fills.length > 0) {
    return shapeTree.fills[0].color;
  }

  // If this is a VECTOR with only strokes (no fill), use stroke color
  if (shapeTree.type === 'VECTOR' && shapeTree.fills.length === 0 && shapeTree.strokes.length > 0) {
    return shapeTree.strokes[0].color;
  }

  // If this is an ELLIPSE with strokes (common in speaker/volume icons), use stroke color
  if (shapeTree.type === 'ELLIPSE' && shapeTree.strokes.length > 0) {
    return shapeTree.strokes[0].color;
  }

  // Check children (skip ROUNDED_RECTANGLEs which are backgrounds)
  for (const child of shapeTree.children) {
    if (child.type === 'ROUNDED_RECTANGLE') continue;
    const color = extractPrimaryColor(child);
    if (color) return color;
  }

  // Last resort: check ROUNDED_RECTANGLE children and strokes
  for (const child of shapeTree.children) {
    const color = extractPrimaryColor(child);
    if (color) return color;
  }

  // Fallback to own strokes
  if (shapeTree.strokes.length > 0) {
    return shapeTree.strokes[0].color;
  }

  return null;
}

/**
 * Collect all unique colors used in the icon subtree.
 */
function collectColors(shapeTree, colors) {
  if (!shapeTree) return;
  shapeTree.fills.forEach(f => {
    if (f.color && !colors.includes(f.color)) colors.push(f.color);
  });
  shapeTree.strokes.forEach(s => {
    if (s.color && !colors.includes(s.color)) colors.push(s.color);
  });
  shapeTree.children.forEach(c => collectColors(c, colors));
}

/**
 * Count total VECTOR nodes in the subtree (for shape complexity).
 */
function countVectors(shapeTree) {
  if (!shapeTree) return 0;
  let count = shapeTree.type === 'VECTOR' ? 1 : 0;
  shapeTree.children.forEach(c => { count += countVectors(c); });
  return count;
}

/**
 * Print a shape tree as indented text.
 */
function printShapeTree(node, indent) {
  const size = node.size ? `${node.size.w}x${node.size.h}` : 'N/A';
  const pos = node.position ? `pos=(${node.position.x},${node.position.y})` : '';
  const fills = node.fills.map(f => f.color).join(',');
  const strokes = node.strokes.map(s => `${s.color}(w=${s.width})`).join(',');
  const blob = node.hasBlob ? ' [BLOB]' : '';
  const opacity = node.opacity < 1 ? ` opacity=${node.opacity.toFixed(4)}` : '';

  let line = `${indent}[${node.type}] "${node.name}" ${size} ${pos}`;
  if (fills) line += ` fills=[${fills}]`;
  if (strokes) line += ` strokes=[${strokes}]`;
  line += opacity + blob;
  console.log(line);

  node.children.forEach(c => printShapeTree(c, indent + '  '));
}

// ── Find icon containers ──

/**
 * Recursively check if a node has any VECTOR or BOOLEAN_OPERATION descendants.
 */
function hasVectorDescendant(key, maxDepth) {
  if (maxDepth <= 0) return false;
  const children = childrenMap[key] || [];
  for (const c of children) {
    if (c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION') return true;
    const ck = guidKey(c.guid);
    if (ck && hasVectorDescendant(ck, maxDepth - 1)) return true;
  }
  return false;
}

const iconContainers = [];

nodes.filter(n => n.type === 'FRAME').forEach(n => {
  if (!n.size) return;
  const w = Math.round(n.size.x);
  const h = Math.round(n.size.y);
  // Icon containers are typically small (under 32px)
  if (w > 32 || h > 32) return;

  const key = guidKey(n.guid);
  if (!key) return;

  // Recursively check for vector descendants (up to 5 levels deep)
  if (!hasVectorDescendant(key, 5)) return;

  // Build shape tree (skipping transparent backgrounds)
  const shapeTree = buildShapeTree(key, 0);
  if (!shapeTree) return;

  // Extract icon info
  const primaryColor = extractPrimaryColor(shapeTree);
  const allColors = [];
  collectColors(shapeTree, allColors);
  const vectorCount = countVectors(shapeTree);

  const parentKey = n.parentIndex && n.parentIndex.guid
    ? guidKey(n.parentIndex.guid) : null;
  const parent = parentKey ? nodeMap[parentKey] : null;

  iconContainers.push({
    name: n.name,
    guid: key,
    size: { w, h },
    parentName: parent ? parent.name : null,
    primaryColor,
    allColors,
    vectorCount,
    shapeTree
  });
});

// ── Output ──

if (jsonMode) {
  // JSON output for programmatic use
  const manifest = iconContainers.map(ic => ({
    name: ic.name,
    guid: ic.guid,
    size: `${ic.size.w}x${ic.size.h}`,
    primaryColor: ic.primaryColor,
    allColors: ic.allColors,
    vectorCount: ic.vectorCount,
    parentName: ic.parentName,
    shapeTree: ic.shapeTree
  }));

  const output = JSON.stringify(manifest, null, 2);
  if (outputPath) {
    fs.writeFileSync(outputPath, output);
    console.log(`Icon inventory written to ${outputPath} (${manifest.length} icons)`);
  } else {
    console.log(output);
  }
} else {
  // Human-readable output
  console.log(`=== ICON INVENTORY (${iconContainers.length} icons found) ===\n`);

  iconContainers.forEach((ic, i) => {
    console.log(`── ${i + 1}. "${ic.name}" [${ic.guid}] ${ic.size.w}x${ic.size.h} ──`);
    console.log(`   Primary color: ${ic.primaryColor || '(none)'}`);
    console.log(`   All colors: [${ic.allColors.join(', ')}]`);
    console.log(`   Vector shapes: ${ic.vectorCount}`);
    console.log(`   Parent: "${ic.parentName || 'N/A'}"`);
    console.log(`   Subtree:`);
    // Print children only (skip the container FRAME itself)
    ic.shapeTree.children.forEach(c => printShapeTree(c, '     '));
    console.log('');
  });

  // Export summary
  console.log('=== SVG EXPORT COMMANDS ===');
  const guids = iconContainers.map(ic => ic.guid).join(',');
  console.log(`\nTotal icons: ${iconContainers.length}`);
  console.log(`Node IDs: ${guids}`);
  console.log('\n# Export via Figma REST API:');
  console.log(`python scripts/export_icons.py /tmp/figma_message.json FILE_KEY -o ./assets/icons/`);
  console.log('\n# Or specify node IDs directly:');
  console.log(`python scripts/export_icons.py --node-ids "${guids}" FILE_KEY -o ./assets/icons/`);
  console.log('\n# Generate JSON inventory for offline use:');
  console.log(`node scripts/extract_vectors.cjs ${inputFile} --json --output /tmp/icon_inventory.json`);
}
