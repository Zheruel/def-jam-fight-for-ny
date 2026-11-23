// DJS1 keeps interleaved PS2 attributes and a shared index buffer ready for GPU upload.
export async function loadScene(model, signal) {
  const url = new URL(`../geometry/venues/${model}.scene.gz`, import.meta.url);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Unable to load venue ${model}`);
  let buffer = await response.arrayBuffer();
  if (new DataView(buffer).getUint16(0) === 0x1f8b) {
    const unpack = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    buffer = await new Response(unpack).arrayBuffer();
  }
  const header = new DataView(buffer);
  if (header.getUint32(0) !== 0x444a5331) throw new Error("Unknown native venue format");
  const size = header.getUint32(4, true);
  const mesh = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, size)));
  if (mesh.model !== model || ![2, 4].includes(mesh.indexBytes)) throw new Error("Invalid venue manifest");
  const start = 8 + size;
  const vertexBytes = mesh.vertices * 24;
  const vertices = new Uint8Array(buffer, start, vertexBytes);
  const indices = new Uint8Array(buffer, start + vertexBytes, mesh.indices * mesh.indexBytes);
  const images = new Map();
  try {
    // Decode one shape at a time to bound memory when a selection is superseded.
    for (const [shape, [offset, length]] of Object.entries(mesh.textures)) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(buffer, start + offset, length);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }),
        { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      images.set(shape, bitmap);
    }
    signal.throwIfAborted();
    return { mesh, vertices, indices, images };
  } catch (error) {
    for (const image of images.values()) image.close();
    throw error;
  }
}

export function uploadScene(gl, program, { mesh, vertices, indices, images }) {
  const vao = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  const textures = new Map();
  function dispose() {
    for (const texture of textures.values()) gl.deleteTexture(texture);
    gl.deleteBuffer(vertexBuffer);
    gl.deleteBuffer(indexBuffer);
    gl.deleteVertexArray(vao);
  }
  try {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    for (const [key, size, type, offset] of [
      ["position", 3, gl.FLOAT, 0], ["uv", 2, gl.FLOAT, 12], ["rgba", 4, gl.UNSIGNED_BYTE, 20],
    ]) {
      const attribute = gl.getAttribLocation(program, key);
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, size, type, type === gl.UNSIGNED_BYTE, 24, offset);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    for (const [shape, bitmap] of images) {
      const texture = gl.createTexture();
      textures.set(shape, texture);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    const neutral = gl.createTexture();
    textures.set(null, neutral);
    gl.bindTexture(gl.TEXTURE_2D, neutral);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("GPU could not upload venue");
    const indexType = mesh.indexBytes === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    return {
      bounds: mesh.bounds,
      draw() {
        gl.bindVertexArray(vao);
        for (const { shape, first, count } of mesh.batches) {
          gl.bindTexture(gl.TEXTURE_2D, textures.get(shape));
          gl.drawElements(gl.TRIANGLES, count, indexType, first * mesh.indexBytes);
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    for (const image of images.values()) image.close();
    gl.bindVertexArray(null);
  }
}
