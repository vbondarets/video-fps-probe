import type { ErrorClass, FileErrorCode, WarningCode } from 'video-fps-probe';

export const ERROR_TEXT: Readonly<Record<FileErrorCode, string>> = {
  'empty-file': 'The file has no bytes.',
  unrecognised: 'Not a video container the package reads, such as an image or a text file.',
  'unsupported-container': 'A container this engine or entry does not read, such as WebM or Matroska in the header-only entry.',
  unsupported: 'A container feature the parser does not support, such as a compressed movie header.',
  'too-large': 'A header box is larger than the parser accepts, such as a moov above 256 MiB.',
  'no-header': 'The container header is missing, such as an MP4 without a moov box.',
  truncated: 'The header is cut off: the file ends before the header does.',
  corrupt: 'A box or element holds values that cannot be right.',
  'no-duration': 'A fragmented file whose header gives no duration, from the header-only entry.',
  'byte-limit': 'Reading the header needs more bytes than maxBytes allows.',
  'read-limit': 'Reading the header needs more reads than maxReads allows.',
  'time-limit': 'The analysis did not finish within maxMs.',
  'structure-limit': 'More tracks than maxTracks, or more top-level boxes than maxTopLevelBoxes.',
  'read-failed': 'Reading the file or the URL failed, such as a network error or a server that ignores Range.',
  'load-failed': 'A parser chunk did not load, such as after a new deploy of the page.',
  'engine-failed': 'mp4box.js, mediabunny or the playback estimate failed on this file.',
  internal: 'An invalid argument or a bug in the package, never a property of the file.',
};

export const CLASS_TEXT: Readonly<Record<ErrorClass, string>> = {
  file: 'About the file itself. The same bytes and package version give the same code, so a server can cache the answer per file and version. The one exception is engine-failed from rvfc, which comes from the browser.',
  limit: 'A limit you set was reached. A larger limit may succeed.',
  io: 'Reading failed. A retry later may succeed.',
  environment: 'The page or the runtime failed, not the file. Reload or retry.',
  internal: 'A bug or an invalid argument. Please report it.',
};

export const WARNING_TEXT: Readonly<Record<WarningCode, string>> = {
  'invalid-timescale': 'A track declares a timescale that cannot be right, such as 0.',
  'truncated-mdat': 'The media data is cut off: the file was not fully written or uploaded.',
  'truncated-box': 'A box other than the media data is cut off.',
  'trailing-data': 'Bytes after the last box were ignored.',
  'fragment-index-unread': 'A limit stopped the read of the fragment index, so a larger limit may resolve the duration.',
  'duration-unresolved': 'The duration of a track could not be resolved from the header.',
  'fragments-ignored': 'Fragments after a moov without an mvex were not read.',
  'structure-limit': 'Too many top-level boxes: the walk stopped there and kept what it had read.',
  'codec-config-unavailable': 'The codec configuration could not be captured, so color and aspect are missing.',
  'metadata-unavailable': 'The color and aspect code did not load, did not load in time or failed, so those fields are missing.',
};

export const MD_COMPRESSION = ['none', 'limited', 'reserved', 'extended'] as const;
