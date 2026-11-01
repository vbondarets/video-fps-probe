'use client';

import { useEffect } from 'react';
import { lazyProbe } from 'video-fps-probe/lazy';

export default function Page() {
  useEffect(() => {
    window.__probe = lazyProbe();
  }, []);
  return <input id="file" type="file" />;
}
