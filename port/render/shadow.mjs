// SLUS-21004 0x16a4a8 blends the venue's shadow lights at the fighter's
// position. Its distance is squared once for each unit of shadowBlend.
function shadowLight(set,position,out) {
  const lights=set.shadowLights;
  if(lights.length===1) return lights[0];
  out.fill(0);
  let total=0;
  for(const light of lights) {
    const dx=light[0]-position[0],dy=light[1]-position[1],dz=light[2]-position[2];
    const squared=dx*dx+dy*dy+dz*dz;
    if(squared===0) return light;
    const weight=1/Math.pow(squared,2**(set.shadow.blend-1));
    for(let j=0;j<3;j++) out[j]+=light[j]*weight;
    total+=weight;
  }
  for(let j=0;j<3;j++) out[j]/=total;
  return out;
}

// 0x116ac8 constructs dot(plane, light)*I - light*transpose(plane).
// The reference match uses a horizontal receiver half a unit above the floor.
export function shadowProjection(set,position,matrix,lightScratch,floor=0.5) {
  const [x,y,z]=shadowLight(set,position,lightScratch), d=y-floor;
  matrix.fill(0);
  matrix[0]=d;
  matrix[4]=-x;
  matrix[5]=-floor;
  matrix[6]=-z;
  matrix[7]=-1;
  matrix[10]=d;
  matrix[12]=x*floor;
  matrix[13]=y*floor;
  matrix[14]=z*floor;
  matrix[15]=y;
  return matrix;
}
