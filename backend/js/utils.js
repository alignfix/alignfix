// Helper function to write large arrays to files in chunks
export function writeFileInChunks(module, filename, lines, chunkSize = 10000) {
  const stream = module.FS.open(filename, 'w');
  
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, Math.min(i + chunkSize, lines.length));
    const text = chunk.join("\n") + (i + chunkSize < lines.length ? "\n" : "");
    const buffer = new TextEncoder().encode(text);
    module.FS.write(stream, buffer, 0, buffer.length);
  }
  
  module.FS.close(stream);
}