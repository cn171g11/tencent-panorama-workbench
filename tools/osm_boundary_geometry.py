"""Small, deterministic OSM administrative multipolygon parser and WGS84->GCJ02.
Panorama point coordinates must not be changed by these boundary helpers.
"""
import math
import xml.etree.ElementTree as ET

AXIS = 6378245.0
ECCENTRICITY = 0.00669342162296594323
EPSILON = 1e-10


def wgs84_to_gcj02(lng, lat):
    if not (math.isfinite(lng) and math.isfinite(lat) and -180 <= lng <= 180 and -90 <= lat <= 90):
        raise ValueError('Invalid WGS84 boundary coordinate')
    if not (72.004 < lng < 137.8347 and 0.8293 < lat < 55.8271):
        return [lng, lat]
    x, y = lng - 105.0, lat - 35.0
    dlat = (-100.0 + 2*x + 3*y + .2*y*y + .1*x*y + .2*math.sqrt(abs(x))
            + (20*math.sin(6*x*math.pi) + 20*math.sin(2*x*math.pi))*2/3
            + (20*math.sin(y*math.pi) + 40*math.sin(y/3*math.pi))*2/3
            + (160*math.sin(y/12*math.pi) + 320*math.sin(y*math.pi/30))*2/3)
    dlng = (300.0 + x + 2*y + .1*x*x + .1*x*y + .1*math.sqrt(abs(x))
            + (20*math.sin(6*x*math.pi) + 20*math.sin(2*x*math.pi))*2/3
            + (20*math.sin(x*math.pi) + 40*math.sin(x/3*math.pi))*2/3
            + (150*math.sin(x/12*math.pi) + 300*math.sin(x/30*math.pi))*2/3)
    rad = lat*math.pi/180
    magic = 1 - ECCENTRICITY*math.sin(rad)**2
    root = math.sqrt(magic)
    return [lng + dlng*180/(AXIS/root*math.cos(rad)*math.pi),
            lat + dlat*180/((AXIS*(1-ECCENTRICITY))/(magic*root)*math.pi)]


def on_segment(x, y, a, b):
    if not (min(a[0], b[0])-EPSILON <= x <= max(a[0], b[0])+EPSILON
            and min(a[1], b[1])-EPSILON <= y <= max(a[1], b[1])+EPSILON):
        return False
    dx, dy = b[0]-a[0], b[1]-a[1]
    return abs((x-a[0])*dy - (y-a[1])*dx) <= EPSILON*max(abs(dx)+abs(dy), EPSILON)


def in_ring(x, y, ring):
    """0 outside, 1 interior, 2 boundary (including closed-ring endpoints)."""
    inside = False
    for i in range(len(ring)):
        a, b = ring[i-1], ring[i]
        if on_segment(x, y, a, b):
            return 2
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return 1 if inside else 0


def contains(polys, x, y):
    return any(in_ring(x, y, polygon[0]) and
               not any(in_ring(x, y, hole) == 1 for hole in polygon[1:])
               for polygon in polys)


def signed_area(ring):
    return .5*sum(ring[i-1][0]*ring[i][1]-ring[i][0]*ring[i-1][1] for i in range(len(ring)))


def assemble_node_rings(segments):
    """Join all supplied way node-id sequences, including reversed members.
    No artificial closing edge or dropped open segment is ever permitted.
    """
    pending = [list(segment) for segment in segments]
    if any(len(segment) < 2 for segment in pending):
        raise ValueError('Degenerate OSM way')
    rings = []
    while pending:
        ring = pending.pop(0)
        while ring[0] != ring[-1]:
            for i, segment in enumerate(pending):
                if ring[-1] == segment[0]:
                    ring.extend(segment[1:])
                elif ring[-1] == segment[-1]:
                    ring.extend(reversed(segment[:-1]))
                elif ring[0] == segment[-1]:
                    ring[:0] = segment[:-1]
                elif ring[0] == segment[0]:
                    ring[:0] = list(reversed(segment[1:]))
                else:
                    continue
                pending.pop(i)
                break
            else:
                raise ValueError('Unclosed OSM ring; do not synthesize closure')
        if len(ring) < 4 or len(set(ring[:-1])) < 3:
            raise ValueError('Degenerate OSM ring')
        rings.append(ring)
    return rings


def group_polygons(outer_rings, inner_rings):
    """Every independent outer is a polygon, not a hole of the first outer."""
    if not outer_rings:
        raise ValueError('Missing outer administrative boundary')
    polygons = [[ring] for ring in outer_rings]
    for ring in outer_rings + inner_rings:
        if ring[0] != ring[-1] or abs(signed_area(ring)) < 1e-12:
            raise ValueError('Unclosed/zero-area coordinate ring')
    for hole in inner_rings:
        owners = [i for i, polygon in enumerate(polygons)
                  if all(in_ring(p[0], p[1], polygon[0]) for p in hole[:-1])]
        if not owners:
            raise ValueError('Inner ring is outside every outer polygon')
        # An island can have its own outer; choose the smallest containing outer.
        owner = min(owners, key=lambda i: abs(signed_area(polygons[i][0])))
        polygons[owner].append(hole)
    return polygons


def parse_relation(raw_xml, relation_id):
    root = ET.fromstring(raw_xml)
    if root.tag != 'osm':
        raise ValueError('Expected OSM XML')
    node_elements = {node.get('id'): node for node in root.findall('node')}
    ways = {way.get('id'): [nd.get('ref') for nd in way.findall('nd')] for way in root.findall('way')}
    relations = {relation.get('id'): relation for relation in root.findall('relation')}
    relation = relations.get(str(relation_id))
    if relation is None:
        raise ValueError('Exact requested relation is absent')
    tags = {tag.get('k'): tag.get('v') for tag in relation.findall('tag')}
    if tags.get('boundary') != 'administrative':
        raise ValueError('Not an administrative OSM relation')
    segments = {'outer': [], 'inner': []}
    used = set()

    def walk(ref, inherited='outer', ancestors=()):
        if ref in ancestors or ref not in relations:
            raise ValueError('Missing/cyclic nested OSM boundary relation')
        rel = relations[ref]
        for member in rel.findall('member'):
            role, kind, child = member.get('role') or 'outer', member.get('type'), member.get('ref')
            if kind == 'node' or role in ('subarea', 'label', 'admin_centre'):
                continue
            if role not in ('outer', 'inner'):
                raise ValueError('Unsupported boundary role: ' + role)
            effective = 'inner' if (inherited == 'inner') != (role == 'inner') else 'outer'
            if kind == 'relation':
                walk(child, effective, ancestors + (ref,))
            elif kind == 'way':
                if child not in ways or child in used:
                    raise ValueError('Missing/repeated OSM way in geometry: ' + str(child))
                used.add(child)
                ids = ways[child]
                if any(node_id not in node_elements for node_id in ids):
                    raise ValueError('Missing referenced OSM node')
                segments[effective].append(ids)
            else:
                raise ValueError('Unknown OSM member type')

    walk(str(relation_id))
    converted = {}
    def point(node_id):
        if node_id not in converted:
            n = node_elements[node_id]
            converted[node_id] = wgs84_to_gcj02(float(n.get('lon')), float(n.get('lat')))
        return converted[node_id]
    outer = [[point(node) for node in ring] for ring in assemble_node_rings(segments['outer'])]
    inner = [[point(node) for node in ring] for ring in assemble_node_rings(segments['inner'])]
    polys = group_polygons(outer, inner)
    return {'tags': tags, 'polys': polys, 'outerRings': len(outer), 'innerRings': len(inner),
            'ways': len(used), 'coordinateNodes': len(converted),
            'osmRelation': int(relation_id), 'osmVersion': relation.get('version'),
            'osmTimestamp': relation.get('timestamp'), 'sourceCrs': 'WGS84', 'crs': 'GCJ-02'}
