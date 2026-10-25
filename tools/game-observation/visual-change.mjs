// Scheduling hint only. Never used to validate/copy facts from a different frame.
export function visualSignature(image) {
 const {width,height,rgb}=image;
 const sums=Array(64).fill(0),counts=Array(64).fill(0);
 const step=Math.max(1,Math.floor(Math.sqrt(width*height/16384)));
 for(let y=0;y<height;y+=step)for(let x=0;x<width;x+=step){
  const i=(y*width+x)*3,t=Math.min(7,Math.floor(y*8/height))*8+Math.min(7,Math.floor(x*8/width));
  sums[t]+=(rgb[i]*.299+rgb[i+1]*.587+rgb[i+2]*.114);counts[t]++;
 }
 return sums.map((sum,i)=>counts[i]?sum/counts[i]:0);
}
export function significantChange(previous,current){
 if(!previous)return true;
 return current.filter((value,i)=>Math.abs(value-previous[i])>=12).length>=4;
}
