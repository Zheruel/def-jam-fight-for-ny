import tiles from "./damage/tiles.json" with {type:"json"};

// Copy the intact texture once per damage stage. Mipmaps are regenerated after
// the original replacement tile is in place, keeping UV seams and minification intact.
export function damageTextures(gl,model,textures) {
  const levels=tiles[model], pending=new Map(), images=new Map(), abort=new AbortController();
  async function upload(level,tile) {
    const response=await fetch(new URL("./damage/"+tile.file,import.meta.url),{signal:abort.signal});
    if(!response.ok) throw Error("Could not load facial damage for "+model);
    const face=await createImageBitmap(await response.blob(),{premultiplyAlpha:"none",colorSpaceConversion:"none"});
    const framebuffer=gl.createFramebuffer(), previous=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    let texture;
    try {
      if(abort.signal.aborted) return;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,textures.get(tile.atlas),0);
      if(gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw Error("Incomplete fighter texture");
      texture=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.copyTexImage2D(gl.TEXTURE_2D,0,gl.RGBA,0,0,...tile.size,0);
      gl.texSubImage2D(gl.TEXTURE_2D,0,tile.x,tile.y,gl.RGBA,gl.UNSIGNED_BYTE,face);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      images.set(level,texture);
    } finally {
      if(texture && !images.has(level)) gl.deleteTexture(texture);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,previous);
      gl.deleteFramebuffer(framebuffer);
      face.close();
    }
  }
  return {
    get(level,shape) {
      const tile=levels?.[level];
      if(!tile || shape!==tile.atlas) return textures.get(shape);
      if(!pending.has(level)) pending.set(level,upload(level,tile).catch(error=>{
        if(!abort.signal.aborted) console.error(error);
      }));
      return images.get(level)??textures.get(shape);
    },
    dispose(){abort.abort();for(const texture of images.values())gl.deleteTexture(texture);}
  };
}
