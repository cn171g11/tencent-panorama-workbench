/* Walk flat PANO_CITY rows a chunk at a time; keep no shard-wide arrays. */
const fs = require('fs');
const { StringDecoder } = require('string_decoder');

function forEachPanoRow(filePath, visit, beginCollection = () => {}) {
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(65536);
  const decoder = new StringDecoder('utf8');
  const assignment = /window\.PANO_CITY\s*\[\s*("(?:[^"\\]|\\.)*")\s*\]\s*=\s*\[/g;
  const maxRowLength = 1048576;
  let buffer = '', position = 0, eof = false, total = 0;
  function refill() {
    buffer = buffer.slice(position);
    position = 0;
    const size = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (size) buffer += decoder.write(chunk.subarray(0, size));
    else { buffer += decoder.end(); eof = true; }
  }
  function skipWhitespace() {
    for (;;) {
      while (position < buffer.length && /\s/.test(buffer[position])) position++;
      if (position < buffer.length) return;
      if (eof) throw new Error('Unterminated collection in ' + filePath);
      refill();
    }
  }
  try {
    for (;;) {
      assignment.lastIndex = position;
      let match = assignment.exec(buffer);
      while (!match && !eof) {
        position = Math.max(position, buffer.length - 256);
        refill();
        assignment.lastIndex = position;
        match = assignment.exec(buffer);
      }
      if (!match) return total;
      const key = JSON.parse(match[1]);
      position = assignment.lastIndex;
      beginCollection(key);
      let first = true;
      for (;;) {
        skipWhitespace();
        if (buffer[position] === ']') { position++; break; }
        if (!first) {
          if (buffer[position] !== ',') throw new Error('Expected row separator in ' + key);
          position++;
          skipWhitespace();
        }
        if (buffer[position] !== '[') throw new Error('Expected panorama row in ' + key);
        let scan = position, depth = 0, inString = false, escaped = false, complete = false;
        while (!complete) {
          for (; scan < buffer.length; scan++) {
            if (scan - position >= maxRowLength) throw new Error('Invalid or oversized panorama row in ' + key);
            const character = buffer[scan];
            if (inString) {
              if (escaped) escaped = false;
              else if (character === '\\') escaped = true;
              else if (character === '"') inString = false;
            } else if (character === '"') inString = true;
            else if (character === '[' || character === '{') depth++;
            else if (character === ']' || character === '}') {
              depth--;
              if (depth === 0) { scan++; complete = true; break; }
            }
          }
          if (!complete) {
            if (eof) throw new Error('Invalid panorama row in ' + key);
            const discarded = position;
            refill();
            scan -= discarded;
          }
        }
        let row;
        try { row = JSON.parse(buffer.slice(position, scan)); }
        catch (error) { throw new Error('Invalid panorama row in ' + key, { cause: error }); }
        position = scan;
        visit(key, row);
        total++;
        first = false;
        if (position >= chunk.length) { buffer = buffer.slice(position); position = 0; }
      }
    }
  } finally { fs.closeSync(descriptor); }
}

module.exports = { forEachPanoRow };
