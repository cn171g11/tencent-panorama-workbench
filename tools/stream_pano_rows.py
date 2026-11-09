"""Read PANO_CITY arrays incrementally without keeping a shard in memory."""
from contextlib import nullcontext
import json
from pathlib import Path
import re

ASSIGNMENT = re.compile(r'window\.PANO_CITY\s*\[\s*("(?:[^"\\]|\\.)*")\s*\]\s*=\s*\[')
CHUNK_SIZE = 65536
MAX_ROW_SIZE = 1048576


def iter_pano_rows(source, on_collection=None):
    """Yield (collection key, original JSON row, decoded row) from a path or text stream."""
    manager = Path(source).open(encoding='utf-8-sig') if isinstance(source, (str, Path)) else nullcontext(source)
    decoder = json.JSONDecoder()
    with manager as stream:
        buffer, position, eof = '', 0, False

        def refill():
            nonlocal buffer, position, eof
            buffer = buffer[position:]
            position = 0
            chunk = stream.read(CHUNK_SIZE)
            if chunk:
                buffer += chunk
            else:
                eof = True

        while True:
            match = ASSIGNMENT.search(buffer, position)
            while match is None and not eof:
                position = max(position, len(buffer) - 256)
                refill()
                match = ASSIGNMENT.search(buffer, position)
            if match is None:
                return
            key = decoder.decode(match.group(1))
            position = match.end()
            if on_collection is not None:
                on_collection(key)
            first = True
            while True:
                while True:
                    while position < len(buffer) and buffer[position].isspace():
                        position += 1
                    if position < len(buffer):
                        break
                    if eof:
                        raise ValueError('Unterminated collection: ' + key)
                    refill()
                if buffer[position] == ']':
                    position += 1
                    break
                if not first:
                    if buffer[position] != ',':
                        raise ValueError('Expected row separator in ' + key)
                    position += 1
                    while True:
                        while position < len(buffer) and buffer[position].isspace():
                            position += 1
                        if position < len(buffer):
                            break
                        if eof:
                            raise ValueError('Unterminated collection: ' + key)
                        refill()
                if buffer[position] != '[':
                    raise ValueError('Expected panorama row in ' + key)
                while True:
                    try:
                        row, end = decoder.raw_decode(buffer, position)
                        break
                    except json.JSONDecodeError:
                        if eof or len(buffer) - position > MAX_ROW_SIZE:
                            raise ValueError('Invalid or oversized panorama row in ' + key)
                        refill()
                raw = buffer[position:end]
                position = end
                first = False
                yield key, raw, row
                if position >= CHUNK_SIZE:
                    buffer = buffer[position:]
                    position = 0
