const MOV_VIDEO_TAGS =
  'rawvideo:raw yuv22vuyyuvs|v210:v210|mjpeg:jpegmjpaAVDJAVRndmb1|mpeg4:mp4vDIVXXVID3IV2|h263:h263s263H263|dvvideo:dvcpdvc dvppdv5pdv5nAVdvAVd1dvhqdvhpdvh1dvh2dvh3dvh4dvh5dvh6|qtrle:rle |cinepak:cvid|svq1:SVQ1svq1svqi|svq3:SVQ3|vvc:vvc1vvi1|hevc:hev1hvc1dvhe|h264:avc1avc2avc3avc4ai5pai5qai52ai53ai55ai56ai1pai1qai12ai13ai15ai16AVinaivxdva1dvav|evc:evc1|vp8:vp08|vp9:vp09|av1:av01|mpeg1video:m1v m1v1mpegmp1v|mpeg2video:m2v1hdv1hdv2hdv3hdv4hdv5hdv6hdv7hdv8hdv9hdvamx5nmx5pmx4nmx4pmx3nmx3pxd51xd54xd55xd59xd5axd5bxd5cxd5dxd5exd5fxdv1xdv2xdv3xdv4xdv5xdv6xdv7xdv8xdv9xdvaxdvbxdvcxdvdxdvexdvfxdhdxdh2AVmpmp2v|jpeg2000:mjp2|png:png MNG |gif:gif |tiff:tiff|vc1:vc-1|cavs:avs2|avs3:avs3|dirac:drac|dnxhd:AVdnAVdh|prores:apchapcnapcsapcoap4hap4x|prores_raw:aprnaprh|hap:Hap1Hap5HapYHapAHapM|cfhd:CFHD|lcevc:lvc1|apv:apv1';

let table: Map<string, string> | null = null;

function videoTags(): Map<string, string> {
  if (table) return table;
  table = new Map();
  for (const group of MOV_VIDEO_TAGS.split('|')) {
    const i = group.indexOf(':');
    const name = group.slice(0, i);
    for (let p = i + 1; p + 4 <= group.length; p += 4) table.set(group.slice(p, p + 4), name);
  }
  return table;
}

const MP4_OBJECT_TYPES: Record<number, string> = {
  0x20: 'mpeg4',
  0x21: 'h264',
  0x23: 'hevc',
  0x33: 'vvc',
  0x60: 'mpeg2video',
  0x61: 'mpeg2video',
  0x62: 'mpeg2video',
  0x63: 'mpeg2video',
  0x64: 'mpeg2video',
  0x65: 'mpeg2video',
  0x6a: 'mpeg1video',
  0x6c: 'mjpeg',
  0x6d: 'png',
  0x6e: 'jpeg2000',
  0xa3: 'vc1',
  0xa4: 'dirac',
  0xb1: 'vp9',
};

export function isVideoFourcc(tag: string): boolean {
  return videoTags().has(tag);
}

export function codecNameFor(tag: string, esdsObjectType: number | null = null, hasHvcc = false): string {
  if (esdsObjectType !== null && MP4_OBJECT_TYPES[esdsObjectType]) return MP4_OBJECT_TYPES[esdsObjectType];
  if (tag === 'dvh1' && hasHvcc) return 'hevc';
  return videoTags().get(tag) ?? 'unknown';
}
