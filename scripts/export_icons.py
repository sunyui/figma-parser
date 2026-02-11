#!/usr/bin/env python3
"""
export_icons.py - Export icon SVGs from Figma using offline-parsed node IDs

Bridges offline .fig parsing (extract_vectors.cjs) with Figma REST API export.
Reads icon node IDs from the parsed data, exports them as SVG via the API,
and saves to the project's assets directory.

Usage:
  # Step 1: Run offline parsing first
  node scripts/extract_archive.cjs design.fig /tmp/fig_extract
  node scripts/decode_kiwi.cjs /tmp/fig_extract/canvas.fig /tmp/fig_message.json

  # Step 2: Export icons via API
  python scripts/export_icons.py /tmp/fig_message.json FILE_KEY --output ./assets/icons/

  # Or specify node IDs directly
  python scripts/export_icons.py --node-ids "0:11,0:30,0:55" FILE_KEY --output ./assets/icons/

Prerequisites:
  - FIGMA_ACCESS_TOKEN environment variable set
  - pip install requests (or use the bundled api/figma_client.py)
"""

import os
import sys
import json
import argparse
import time
import re
from pathlib import Path

# Add api/ directory to path for figma_client import
sys.path.insert(0, str(Path(__file__).parent / 'api'))
from figma_client import FigmaClient


def _has_vector_descendant(guid, children_map, node_map, max_depth=5):
    """Recursively check if a node has any VECTOR or BOOLEAN_OPERATION descendants."""
    if max_depth <= 0:
        return False
    for c in children_map.get(guid, []):
        ctype = c.get('type', '')
        if ctype in ('VECTOR', 'BOOLEAN_OPERATION'):
            return True
        cg = c.get('guid', {})
        cguid = f"{cg.get('sessionID', 0)}:{cg.get('localID', 0)}"
        if _has_vector_descendant(cguid, children_map, node_map, max_depth - 1):
            return True
    return False


def _color_to_hex(c):
    """Convert Figma 0-1 float RGBA color to hex string."""
    if not c:
        return None
    r = round(c.get('r', 0) * 255)
    g = round(c.get('g', 0) * 255)
    b = round(c.get('b', 0) * 255)
    return '#{:02x}{:02x}{:02x}'.format(r, g, b)


def _extract_primary_color(guid, children_map, node_map):
    """
    Extract primary icon color by traversing the shape subtree.
    Priority: topmost BOOLEAN_OPERATION fill > first VECTOR fill > stroke color.
    Skips transparent background ROUNDED_RECTANGLEs (opacity < 0.01).
    """
    for c in children_map.get(guid, []):
        ctype = c.get('type', '')
        opacity = c.get('opacity', 1)

        # Skip transparent backgrounds
        if ctype == 'ROUNDED_RECTANGLE' and opacity < 0.01:
            continue

        # BOOLEAN_OPERATION with fill = icon color
        if ctype == 'BOOLEAN_OPERATION':
            fills = c.get('fillPaints', [])
            for f in fills:
                color = _color_to_hex(f.get('color'))
                if color:
                    return color

        # VECTOR with fill
        if ctype == 'VECTOR':
            fills = c.get('fillPaints', [])
            for f in fills:
                color = _color_to_hex(f.get('color'))
                if color:
                    return color

        # Recurse into children
        cg = c.get('guid', {})
        cguid = f"{cg.get('sessionID', 0)}:{cg.get('localID', 0)}"
        color = _extract_primary_color(cguid, children_map, node_map)
        if color:
            return color

    return None


def _count_vectors(guid, children_map):
    """Count total VECTOR nodes in subtree."""
    count = 0
    for c in children_map.get(guid, []):
        if c.get('type') == 'VECTOR':
            count += 1
        cg = c.get('guid', {})
        cguid = f"{cg.get('sessionID', 0)}:{cg.get('localID', 0)}"
        count += _count_vectors(cguid, children_map)
    return count


def find_icon_containers(message_json_path: str) -> list:
    """
    Find icon container nodes from parsed Figma message JSON.
    Recursively traverses up to 5 levels deep to find icons with nested structures.
    Extracts primary color and vector count for each icon.
    """
    with open(message_json_path, 'r') as f:
        data = json.load(f)

    nodes = data.get('nodeChanges', [])

    # Build lookup maps
    node_map = {}
    children_map = {}  # parent_guid -> [child_nodes]

    for n in nodes:
        g = n.get('guid', {})
        guid = f"{g.get('sessionID', 0)}:{g.get('localID', 0)}"
        node_map[guid] = n

        pi = n.get('parentIndex', {})
        pg = pi.get('guid', {})
        parent_guid = f"{pg.get('sessionID', 0)}:{pg.get('localID', 0)}"
        if parent_guid not in children_map:
            children_map[parent_guid] = []
        children_map[parent_guid].append(n)

    # Find icon containers: small FRAMEs with vector descendants (recursive)
    icon_nodes = []
    seen_guids = set()

    for n in nodes:
        ntype = n.get('type', '')
        size = n.get('size', {})
        w = size.get('x', 999)
        h = size.get('y', 999)
        name = n.get('name', '')

        g = n.get('guid', {})
        guid = f"{g.get('sessionID', 0)}:{g.get('localID', 0)}"

        # Icon container: small FRAME with vector/boolean descendants
        if ntype == 'FRAME' and w <= 32 and h <= 32:
            if _has_vector_descendant(guid, children_map, node_map) and guid not in seen_guids:
                primary_color = _extract_primary_color(guid, children_map, node_map)
                vector_count = _count_vectors(guid, children_map)
                icon_nodes.append({
                    'guid': guid,
                    'name': name,
                    'type': ntype,
                    'size': f"{int(w)}x{int(h)}",
                    'primaryColor': primary_color,
                    'vectorCount': vector_count
                })
                seen_guids.add(guid)

    return icon_nodes


def export_icons_via_api(client: FigmaClient, file_key: str,
                         node_ids: list, output_dir: str,
                         fmt: str = 'svg', scale: float = 1.0) -> list:
    """Export icons by node ID via Figma REST API and download to output_dir."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Figma API limits node IDs per request
    BATCH_SIZE = 50
    exported = []

    for i in range(0, len(node_ids), BATCH_SIZE):
        batch = node_ids[i:i + BATCH_SIZE]
        batch_ids = ','.join(batch)

        print(f"Requesting export for {len(batch)} nodes (batch {i // BATCH_SIZE + 1})...")

        try:
            result = client.export_images(file_key, batch_ids, format=fmt, scale=scale)
        except Exception as e:
            print(f"  API error: {e}")
            continue

        images = result.get('images', {})
        if not images:
            print("  No images returned")
            continue

        for node_id, image_url in images.items():
            if not image_url:
                print(f"  Skipped {node_id}: no URL")
                continue

            # Generate filename from node ID
            safe_name = node_id.replace(':', '-')
            filename = f"icon-{safe_name}.{fmt}"
            filepath = Path(output_dir) / filename

            try:
                client.download_image(image_url, str(filepath))
                exported.append({
                    'node_id': node_id,
                    'file': str(filepath),
                    'format': fmt,
                    'url': image_url
                })
                print(f"  Downloaded: {filepath}")
            except Exception as e:
                print(f"  Download failed for {node_id}: {e}")

        # Rate limiting between batches
        if i + BATCH_SIZE < len(node_ids):
            time.sleep(1)

    return exported


def rename_icons(exported: list, node_map: dict, output_dir: str):
    """Rename exported icon files using Figma node names instead of IDs."""
    for item in exported:
        node_id = item['node_id']
        node = node_map.get(node_id)
        if not node:
            continue

        name = node.get('name', '')
        if not name:
            continue

        # Sanitize name for filename
        safe_name = re.sub(r'[^\w\-]', '_', name).strip('_').lower()
        if not safe_name:
            continue

        fmt = item['format']
        new_filename = f"{safe_name}.{fmt}"
        new_filepath = Path(output_dir) / new_filename

        # Handle duplicates
        counter = 1
        while new_filepath.exists():
            new_filename = f"{safe_name}_{counter}.{fmt}"
            new_filepath = Path(output_dir) / new_filename
            counter += 1

        old_filepath = Path(item['file'])
        if old_filepath.exists():
            old_filepath.rename(new_filepath)
            item['file'] = str(new_filepath)
            item['name'] = name
            print(f"  Renamed: {old_filepath.name} -> {new_filename}")


def main():
    parser = argparse.ArgumentParser(
        description='Export icon SVGs from Figma using offline-parsed node IDs'
    )
    parser.add_argument('message_json', nargs='?',
                        help='Path to decoded Figma message JSON (from decode_kiwi.cjs)')
    parser.add_argument('file_key',
                        help='Figma file key or URL (for API export)')
    parser.add_argument('--node-ids',
                        help='Comma-separated node IDs (skip auto-detection)')
    parser.add_argument('--output', '-o', default='./assets/icons',
                        help='Output directory (default: ./assets/icons)')
    parser.add_argument('--format', '-f', default='svg',
                        choices=['svg', 'png', 'pdf'],
                        help='Export format (default: svg)')
    parser.add_argument('--scale', '-s', type=float, default=1.0,
                        help='Export scale (default: 1.0)')
    parser.add_argument('--token',
                        help='Figma access token (overrides FIGMA_ACCESS_TOKEN env)')
    parser.add_argument('--rename', action='store_true', default=True,
                        help='Rename files using Figma node names (default: true)')
    parser.add_argument('--no-rename', dest='rename', action='store_false',
                        help='Keep node ID based filenames')
    parser.add_argument('--dry-run', action='store_true',
                        help='Show what would be exported without making API calls')

    args = parser.parse_args()

    # Determine node IDs
    node_ids = []
    node_name_map = {}

    if args.node_ids:
        node_ids = [nid.strip() for nid in args.node_ids.split(',')]
        print(f"Using {len(node_ids)} specified node IDs")
    elif args.message_json:
        if not os.path.exists(args.message_json):
            print(f"File not found: {args.message_json}", file=sys.stderr)
            sys.exit(1)

        print(f"Scanning {args.message_json} for icon containers...")
        icons = find_icon_containers(args.message_json)
        node_ids = [icon['guid'] for icon in icons]

        # Build name map for renaming
        with open(args.message_json, 'r') as f:
            data = json.load(f)
        for n in data.get('nodeChanges', []):
            g = n.get('guid', {})
            guid = f"{g.get('sessionID', 0)}:{g.get('localID', 0)}"
            node_name_map[guid] = n

        print(f"Found {len(icons)} icon containers:")
        for icon in icons:
            print(f"  {icon['guid']} \"{icon['name']}\" {icon['size']} color={icon.get('primaryColor', 'N/A')} vectors={icon.get('vectorCount', '?')}")
    else:
        print("Provide either message_json or --node-ids", file=sys.stderr)
        parser.print_help()
        sys.exit(1)

    if not node_ids:
        print("No icon nodes found to export")
        sys.exit(0)

    if args.dry_run:
        print(f"\n[Dry run] Would export {len(node_ids)} icons as {args.format}")
        print(f"[Dry run] File key: {args.file_key}")
        print(f"[Dry run] Output: {args.output}")
        print(f"[Dry run] Node IDs: {','.join(node_ids)}")
        sys.exit(0)

    # Check token
    token = args.token or os.getenv('FIGMA_ACCESS_TOKEN')
    if not token:
        print("Error: FIGMA_ACCESS_TOKEN not set.", file=sys.stderr)
        print("Set it via: export FIGMA_ACCESS_TOKEN=your-token", file=sys.stderr)
        print("Get a token at: https://www.figma.com/developers/api#access-tokens",
              file=sys.stderr)
        sys.exit(1)

    # Initialize client and export
    client = FigmaClient(access_token=token)
    file_key = client.parse_file_url(args.file_key)

    print(f"\nExporting {len(node_ids)} icons as {args.format} to {args.output}...")
    exported = export_icons_via_api(
        client, file_key, node_ids, args.output,
        fmt=args.format, scale=args.scale
    )

    # Rename files using Figma node names
    if args.rename and node_name_map and exported:
        print("\nRenaming files using node names...")
        rename_icons(exported, node_name_map, args.output)

    # Write manifest
    manifest_path = Path(args.output) / 'export-manifest.json'

    # Enrich exported entries with icon metadata from auto-detection
    icon_meta = {}
    if args.message_json and os.path.exists(args.message_json):
        icons = find_icon_containers(args.message_json)
        for ic in icons:
            icon_meta[ic['guid']] = ic

    for item in exported:
        meta = icon_meta.get(item['node_id'], {})
        item['primaryColor'] = meta.get('primaryColor')
        item['vectorCount'] = meta.get('vectorCount')
        item['size'] = meta.get('size')

    manifest = {
        'exported_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'file_key': file_key,
        'format': args.format,
        'scale': args.scale,
        'total': len(exported),
        'icons': exported
    }
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f"\nDone! {len(exported)}/{len(node_ids)} icons exported to {args.output}")
    print(f"Manifest: {manifest_path}")


if __name__ == '__main__':
    main()
