const BASE_URL = 'https://music-api.gdstudio.xyz/api.php';

function normalizeText(text: string): string {
  if (!text) return '';
  const stripped = text
    .toLowerCase()
    .replace(/[（(【[].*?[)）】\]]/g, '')
    .replace(/[\s\-—_·・'"''""!！?？.,，。&＆+]/g, '');
  return stripped || text.toLowerCase().replace(/[\s\-—_·・'"''""!！?？.,，。&＆+]/g, '');
}

function isNameMatched(expectedName: string, candidateName: string): boolean {
  const expected = normalizeText(expectedName);
  const candidate = normalizeText(candidateName);
  if (!expected || !candidate) return false;
  return expected === candidate || candidate.includes(expected) || expected.includes(candidate);
}

function pickBestCandidate(candidates: any[], expected: { name: string; artists: string[] }): any | null {
  let best: any = null;
  let bestScore = 0;
  for (const item of candidates) {
    if (!item?.id) continue;
    if (!isNameMatched(expected.name, item.name || '')) continue;
    const candidateArtist = normalizeText(Array.isArray(item.artist) ? item.artist.map((a: any) => a.name || a).join(' ') : (item.artist || ''));
    let score: number;
    if (expected.artists.length === 0) {
      score = 2;
    } else if (!candidateArtist) {
      score = 1;
    } else {
      const artistMatched = expected.artists.some((name) => {
        const n = normalizeText(name);
        return !!n && (candidateArtist.includes(n) || n.includes(candidateArtist));
      });
      if (!artistMatched) continue;
      score = 3;
    }
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

async function searchAndGetUrl(source: string, searchQuery: string, expected: { name: string; artists: string[] }, quality: string): Promise<{ url: string; br: string; size: number; source: string } | null> {
  const searchUrl = `${BASE_URL}?types=search&source=${source}&name=${encodeURIComponent(searchQuery)}&count=5&pages=1`;
  const resp = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
  const data = await resp.json() as any;
  if (!Array.isArray(data) || !data.length) return null;
  const matched = pickBestCandidate(data, expected);
  if (!matched) return null;
  const trackId = matched.id;
  const trackSource = matched.source || source;
  const songUrl = `${BASE_URL}?types=url&source=${trackSource}&id=${trackId}&br=${quality}`;
  const songResp = await fetch(songUrl, { signal: AbortSignal.timeout(8000) });
  const songData = await songResp.json() as any;
  if (songData?.url) {
    return { url: songData.url.replace(/\\/g, ''), br: String(songData.br || ''), size: songData.size || 0, source: trackSource };
  }
  return null;
}

export async function parseFromGDMusic(params: {
  name: string; artists: string[]; quality?: string; timeout?: number;
}): Promise<{ url: string; quality: string; trial: boolean; size: number } | null> {
  const { name, artists, quality = '999', timeout = 15000 } = params;
  const searchQuery = (name + ' ' + (artists || []).join(' ')).trim();
  if (searchQuery.length < 2) return null;
  const expected = { name, artists: artists || [] };
  const sources = ['joox', 'tidal', 'netease'];
  const race = new Promise<null>((r) => setTimeout(() => r(null), timeout));
  const work = (async () => {
    for (const src of sources) {
      try {
        const result = await searchAndGetUrl(src, searchQuery, expected, quality);
        if (result?.url) return { url: result.url, quality: 'gdmusic-' + result.source, trial: false, size: result.size };
      } catch { /* next */ }
    }
    return null;
  })();
  return Promise.race([work, race]);
}
