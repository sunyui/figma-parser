---
name: fig-parser
description: Parse local Figma .fig binary files offline and extract complete design specifications. Extracts node tree, layout data, images, text styles, gradients, effects, and icon metadata. Optionally integrates with Figma REST API for SVG icon export when credentials are available.
---

# Figma .fig File Parser

Parse local `.fig` binary files **without** a Figma account or API access. Extract complete design data including layout, typography, colors, images, icons, gradients, effects, and auto-layout properties. Generate structured design specification documents for frontend development.

## Core Capabilities

### 1. Binary .fig Parsing (Offline)
- Parse the `fig-kiwi` binary format using `kiwi-schema` + `fzstd`/`pako`
- Decompress zstd/deflate-compressed schema and data chunks
- Decode the full Figma node tree with all properties
- Extract embedded raster images (PNG/JPEG) by hash

### 2. Design Data Extraction
- **Node tree**: Complete hierarchy with type, name, size, position, parent relationships
- **Layout**: Position coordinates, auto-layout (stack mode, spacing, padding, alignment)
- **Typography**: Font family, size, weight, line height, letter spacing, text content, styled segments
- **Colors**: Solid fills, gradients (linear/radial/angular) with stops and transforms
- **Effects**: Drop shadows, inner shadows, blur, foreground blur with full parameters
- **Images**: Raster image extraction with hash-to-node mapping
- **Icons**: Vector nodes, boolean operations, compound shapes with fill colors

### 3. SVG Icon Export (Online, Optional)
When `FIGMA_ACCESS_TOKEN` and a cloud `file_key` are available:
- Use Figma REST API to export any node as SVG by its guid
- Batch export all icon nodes identified during offline parsing
- Falls back to manual SVG description when API is unavailable

## Quick Start

### Prerequisites
```bash
# Install Node.js dependencies (in a temp/working directory)
npm install kiwi-schema pako fzstd
```

### Step-by-Step Workflow

#### Step 1: Extract the .fig archive
```bash
node scripts/extract_archive.cjs /path/to/design.fig /tmp/figma_extract
```
This produces:
- `/tmp/figma_extract/canvas.fig` - the main kiwi-encoded design data
- `/tmp/figma_extract/images/` - embedded raster images (hash filenames)
- `/tmp/figma_extract/meta.json` - file metadata (name, thumbnail, export date)
- `/tmp/figma_extract/thumbnail.png` - file thumbnail

#### Step 2: Decode the kiwi binary into JSON
```bash
node scripts/decode_kiwi.cjs /tmp/figma_extract/canvas.fig /tmp/figma_message.json
```
This produces a large JSON file with all `nodeChanges` - the full Figma document tree.

#### Step 3: Extract structured layout data
```bash
node scripts/extract_layout.cjs /tmp/figma_message.json /tmp/figma_layout.json
```
Produces a flat JSON array of all nodes with: name, type, guid, size, position, parentGuid, fills, strokes, effects, text data, corner radii, auto-layout properties, opacity, visibility.

#### Step 4: Generate hierarchy tree
```bash
node scripts/extract_hierarchy.cjs /tmp/figma_message.json /tmp/figma_tree.txt
```
Produces a human-readable indented tree showing the visual hierarchy with key properties.

#### Step 5: Extract specialized data
```bash
# Image hash-to-node mapping
node scripts/extract_images.cjs /tmp/figma_message.json

# Gradient details (stops, transforms)
node scripts/extract_gradients.cjs /tmp/figma_message.json

# Vector/icon node analysis
node scripts/extract_vectors.cjs /tmp/figma_message.json
```

#### Step 6 (Optional): Export icons as SVG via Figma API
```bash
# Requires: FIGMA_ACCESS_TOKEN env var + file_key
python ../figma/scripts/figma_client.py export-images FILE_KEY \
  --node-ids "0:11,0:30,0:45" --format svg
```

### Generating a Design Spec Document

After running steps 1-5, use the extracted data to write a comprehensive `design-spec.md`. The recommended structure:

1. **Global Layout** - Page dimensions, background, coordinate system
2. **Color Palette** - All unique colors extracted from fills
3. **Typography Scale** - Font sizes, weights, line heights by hierarchy level
4. **Component Breakdown** - Each visual module with:
   - Exact pixel coordinates and dimensions
   - Spacing calculations (derived from position differences)
   - Fill colors, gradients, effects
   - Text content and styles
   - Icon descriptions with node names and guids
5. **Image Assets** - Hash-to-filename mapping, usage locations
6. **Icon Inventory** - All vector/boolean-op nodes with sizes, colors, parent containers, **and exported SVG file paths** (e.g. `assets/icons/xxx.svg`). After running the SVG export step, cross-reference the `export-manifest.json` to populate the "导出 SVG 路径" column. Icons that could not be exported (empty rectangles) or are implemented as inline SVG should be marked accordingly.

## .fig Binary Format Reference

### Archive Structure
```
[8 bytes]  Header prelude: "fig-kiwi" (exactly 8 bytes, no null padding)
[4 bytes]  Version number (uint32 LE, e.g., 106)
[4 bytes]  Chunk 0 size (uint32 LE) - Schema (deflate-raw compressed)
[N bytes]  Chunk 0 data
[4 bytes]  Chunk 1 size (uint32 LE) - Message (zstd or deflate-raw compressed)
[N bytes]  Chunk 1 data
```
Note: Newer .fig files (version >= ~100) use **zstd** compression for the message
chunk. Detect by checking for the zstd magic number `0xFD2FB528` (bytes: `28 B5 2F FD`)
at the start of chunk 1. Schema chunk always uses deflate-raw.

But modern .fig files are actually **ZIP archives** containing:
- `canvas.fig` - The kiwi-encoded design data (fig-kiwi format as above)
- `meta.json` - File metadata
- `thumbnail.png` - Preview image
- `images/` - Directory of embedded raster images (named by content hash)

### Kiwi Binary Decoding
1. Decompress chunk 0 with `pako.inflateRaw()` to get the binary schema
2. Use `kiwi-schema.decodeBinarySchema()` to parse the schema definition
3. Use `kiwi-schema.compileSchema()` to create a decoder
4. Decompress chunk 1 with `pako.inflateRaw()` to get the binary message
5. Use `compiledSchema.decodeMessage()` to decode into JSON

### Node Structure (decoded JSON)
```json
{
  "type": "NODE_CHANGES",
  "nodeChanges": [
    {
      "guid": { "sessionID": 0, "localID": 42 },
      "parentIndex": { "guid": { "sessionID": 0, "localID": 2 }, "position": "..." },
      "type": "FRAME|TEXT|VECTOR|ROUNDED_RECTANGLE|ELLIPSE|BOOLEAN_OPERATION|...",
      "name": "Node Name",
      "size": { "x": 100, "y": 50 },
      "transform": { "m00": 1, "m01": 0, "m02": 450, "m10": 0, "m11": 1, "m12": 200 },
      "fillPaints": [{ "type": "SOLID", "color": { "r": 0.09, "g": 0.03, "b": 0.16, "a": 1 } }],
      "strokePaints": [...],
      "effects": [{ "type": "DROP_SHADOW", "color": {...}, "offset": {...}, "radius": 15, "spread": 0 }],
      "cornerRadius": 12,
      "opacity": 0.86,
      "textData": { "characters": "Hello", "glyphs": [...] },
      "fontSize": 16,
      "fontWeight": 500,
      "lineHeight": { "value": 32, "units": "PIXELS" },
      "stackMode": "VERTICAL",
      "stackSpacing": 8,
      "vectorNetworkBlob": "..."
    }
  ]
}
```

### Key Field Reference

| Field | Description |
|-------|-------------|
| `guid` | Unique node ID: `{sessionID}:{localID}` format (e.g., "0:42") |
| `parentIndex.guid` | Parent node's guid |
| `transform.m02` / `m12` | X and Y position (relative to parent or canvas) |
| `size.x` / `size.y` | Width and height in pixels |
| `fillPaints` | Array of fill paints (SOLID, IMAGE, GRADIENT_LINEAR, etc.) |
| `fillPaints[].color` | RGBA color with values 0-1 (multiply by 255 for hex) |
| `fillPaints[].image.hash` | 20-byte array - convert to hex for image filename |
| `fillPaints[].gradientStops` | Array of `{ color, position }` for gradients |
| `strokePaints` | Array of stroke paints |
| `strokeWeight` | Stroke width in pixels |
| `effects` | Array of effects (DROP_SHADOW, INNER_SHADOW, FOREGROUND_BLUR, etc.) |
| `cornerRadius` | Single corner radius |
| `rectangleCornerRadii` | Per-corner radii `[tl, tr, br, bl]` |
| `stackMode` | Auto-layout direction: VERTICAL, HORIZONTAL, or absent |
| `stackSpacing` | Gap between auto-layout children |
| `paddingLeft/Right/Top/Bottom` | Auto-layout padding |
| `textData.characters` | Full text content |
| `textData.glyphs` | Per-character style data (font, size, color) |
| `fontSize` / `fontWeight` / `lineHeight` | Typography properties |
| `vectorNetworkBlob` | Binary blob for vector paths - CANNOT be converted to SVG offline |
| `visible` | Boolean, false if node is hidden |
| `opacity` | 0-1 float |

## Known Limitations & Solutions

### vectorNetworkBlob Cannot Be Converted to SVG Offline
**Problem**: Vector nodes (icons) store their path data in `vectorNetworkBlob`, a proprietary binary format. There is no public documentation or open-source decoder for this blob format. The `fillGeometry` and `strokeGeometry` fields that contain SVG path strings are only available through the Figma REST API, not in the .fig binary.

**Solutions (in priority order)**:
1. **Figma REST API** (best): If you have `FIGMA_ACCESS_TOKEN` + `file_key`, use `export_images(file_key, node_ids, format='svg')` to export any node as clean SVG. This is the recommended approach. See `../figma/scripts/figma_client.py`.
2. **Manual SVG recreation**: Use the extracted node tree (positions, sizes, colors, child relationships) to manually recreate icons in SVG/JSX. The tree shows the geometric primitives (rectangles, ellipses, boolean operations) that compose each icon.
3. **Screenshot tracing**: Use the exported PNG screenshots as visual reference to hand-draw SVG paths.

### Image Hash Format
Image hashes in `fillPaints[].image.hash` are objects with numeric keys `{0: byte, 1: byte, ...}` (20 bytes). Convert to hex string to match filenames in the `images/` directory:
```javascript
function hashToHex(hash) {
    if (!hash) return null;
    let hex = '';
    for (let i = 0; i < 20; i++) {
        const byte = hash[i];
        if (byte === undefined) break;
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex || null;
}
```

### Color Conversion
Colors in the .fig format use 0-1 float RGBA. Convert to hex:
```javascript
function colorToHex(c) {
    const r = Math.round(c.r * 255);
    const g = Math.round(c.g * 255);
    const b = Math.round(c.b * 255);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
```

### Position Coordinates
`transform.m02` and `transform.m12` give X and Y position. For top-level children of a FRAME, these are absolute canvas coordinates. For nested children, these are relative to the parent frame's origin.

## Integration with Figma REST API

This skill includes a bundled Figma REST API client (`scripts/api/figma_client.py`) and
an integrated icon export script (`scripts/export_icons.py`). These enable SVG export of
vector icons that cannot be extracted offline due to the proprietary `vectorNetworkBlob` format.

### Prerequisites for API Export
```bash
# Python 3.7+ with requests library
pip install requests

# Figma access token (get from https://www.figma.com/developers/api#access-tokens)
export FIGMA_ACCESS_TOKEN="your-token-here"

# The .fig file must also exist in Figma cloud — get file_key from the URL:
# https://www.figma.com/file/FILE_KEY/File-Name → FILE_KEY
```

### Quick Icon Export (One Command)
```bash
# Auto-detect all icon nodes from parsed JSON and export as SVG
python scripts/export_icons.py /tmp/figma_message.json FILE_KEY -o ./assets/icons/

# Or specify node IDs manually
python scripts/export_icons.py --node-ids "0:11,0:30,0:55" FILE_KEY -o ./assets/icons/

# Dry run — show what would be exported without API calls
python scripts/export_icons.py /tmp/figma_message.json FILE_KEY --dry-run
```

### Full Workflow: Offline Parse + Online SVG Export
```
1. Extract .fig archive         → node scripts/extract_archive.cjs design.fig /tmp/fig_extract
2. Decode kiwi binary           → node scripts/decode_kiwi.cjs /tmp/fig_extract/canvas.fig /tmp/fig_message.json
3. Identify icon nodes          → node scripts/extract_vectors.cjs /tmp/fig_message.json
4. Export icons via Figma API   → python scripts/export_icons.py /tmp/fig_message.json FILE_KEY -o ./assets/icons/
5. Update design spec           → Use export-manifest.json to populate the "导出 SVG 路径" column in the Icon Inventory table
```

The export step generates an `export-manifest.json` in the output directory containing node_id → file path mappings. When writing the design spec's Icon Inventory (矢量图标清单), use this manifest to fill in the exported SVG path for each icon. Icons that failed to export (empty rectangles, 162 bytes) should be noted and re-attempted via .fig binary VectorNetwork decoding or marked as inline SVG.

### Fallback Without API Access
If `FIGMA_ACCESS_TOKEN` is not available:
1. Use `extract_vectors.cjs` output to see icon structure (parent containers, child shapes, colors)
2. Use `extract_hierarchy.cjs` tree to understand each icon's geometric composition
3. Manually create SVG/JSX icon components based on the structural description

### Direct API Usage
```bash
# Export specific nodes as SVG
python scripts/api/figma_client.py export-images FILE_KEY --node-ids "0:11,0:30" --format svg

# Get full file structure from Figma cloud
python scripts/api/figma_client.py get-file FILE_KEY

# Export design tokens (colors, typography) from cloud file
python scripts/api/export_manager.py export-tokens FILE_KEY --token-format css

# Batch export all components
python scripts/api/export_manager.py export-components FILE_KEY --formats svg,png --output-dir ./exports/
```

### Icon Node Identification Heuristics
- Type is `VECTOR` or `BOOLEAN_OPERATION`
- Parent is a small `FRAME` (typically 16x16, 20x20, 24x24)
- Parent name is descriptive (e.g., "faxiandengpao", "tousuyujianyi", "shijian-2")
- Has solid color fill (icon color)
- Size is small (under 32x32)

## Resources

### scripts/ (Offline Parsing — Node.js)
- `extract_archive.cjs` - Unzip .fig archive, extract canvas.fig + images + metadata
- `decode_kiwi.cjs` - Decode canvas.fig kiwi binary into full JSON
- `extract_layout.cjs` - Extract flat node array with all visual properties
- `extract_hierarchy.cjs` - Generate indented tree visualization
- `extract_images.cjs` - Map image hashes to node usage
- `extract_gradients.cjs` - Extract gradient details (stops, transforms, effects)
- `extract_vectors.cjs` - Identify vector/icon nodes for SVG export

### scripts/ (API Integration — Python)
- `export_icons.py` - End-to-end icon export: auto-detect icons + API export + rename + manifest

### scripts/api/ (Figma REST API Client — Python)
- `figma_client.py` - Complete Figma API wrapper (auth, rate limiting, file/image/component endpoints)
- `export_manager.py` - Batch export manager (frames, components, pages, design tokens, client packages)

### references/
- `figma-api-reference.md` - Figma REST API documentation and examples
- `export-formats.md` - Asset export format specifications (PNG, SVG, PDF, WEBP)

## Example Output

### Tree Output (figma_tree.txt)
```
[FRAME] "Main Frame" 1440x2748 @(-91,-706) fill=[#f9f9f9]
  [TEXT] "Title" 64x22 @(478,496) fill=[#070828] "Title Text" 16px
  [FRAME] "Icon Container" 20x20 @(450,497) fill=[#ffffff]
    [FRAME] "Group 27" 14x15 @(3,3) fill=[#ffffff]
      [BOOLEAN_OPERATION] "Union" 14x15 @(0,0) fill=[#1677ff]
        [VECTOR] "Rectangle" 14x15 @(0,0) fill=[#1f8ffb] r=1.75
        [ROUNDED_RECTANGLE] "Bar 1" 4x2 @(3,4) fill=[#ffffff] r=0.875
```

### Layout JSON (per node)
```json
{
  "name": "Title Text",
  "type": "TEXT",
  "guid": "0:9",
  "size": { "w": 64, "h": 22 },
  "position": { "x": 478, "y": 496 },
  "parentGuid": "0:2",
  "fills": [{ "type": "SOLID", "color": "#070828", "opacity": 1 }],
  "text": "Multi-dimension Analysis",
  "fontSize": 16,
  "lineHeight": { "value": 100, "units": "PERCENT" }
}
```
