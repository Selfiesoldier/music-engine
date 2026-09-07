export class SmartTitleParser {
  static clean(rawTitle = '', rawArtist = '') {
    if (!rawTitle) return { title: 'Unknown Track', artist: rawArtist || 'Unknown Artist' };

    let text = rawTitle;
    let explicitArtist = null;

    // 1. Clean YouTube Music Topic / VEVO channel: "Alan Walker - Topic" -> "Alan Walker"
    let cleanRawArtist = (rawArtist || '')
      .replace(/ - Topic$/i, '')
      .replace(/VEVO$/i, '')
      .replace(/Official Channel/i, '')
      .trim();

    // 2. Cut off secondary SEO pipes/slashes e.g. '| Desi Balak Gama Ke | New Haryanvi Songs 2023'
    if (text.includes('|')) {
      text = text.split('|')[0].trim();
    }
    if (text.includes('//')) {
      text = text.split('//')[0].trim();
    }

    // 3. Detect "Title (Official Video) Artist" separator pattern
    const videoTagMatch = text.match(/^(.*?)\s*[\(\[](?:official|video|music video|mv)[^\)\]]*[\)\]]\s*(.*)$/i);
    if (videoTagMatch && videoTagMatch[1] && videoTagMatch[2]) {
      const part1 = videoTagMatch[1].trim();
      const part2 = videoTagMatch[2].trim();
      if (part1.length > 1 && part2.length > 1 && !part2.includes('-')) {
        text = part1;
        explicitArtist = part2;
      }
    }

    // 4. Remove bracketed / parenthesized metadata
    text = text.replace(/[\[\(].*?(official|video|audio|lyrics|music|remix|hd|4k|mv|visualizer|prod\.|produced).*?[\)\]]/gi, '');
    text = text.replace(/[\[\(].*?[\)\]]/g, '');

    // 5. Remove common marketing buzzwords & years
    text = text.replace(/\b(official|music video|official video|lyric video|full song|new song|hd|4k)\b/gi, '');
    text = text.replace(/\b(202[0-9]|201[0-9])\b/g, '');

    let parsedArtist = explicitArtist || cleanRawArtist;
    let parsedTitle = text.trim();

    // 6. Split by ' - ' (Artist - Title OR Title - Artist)
    if (text.includes(' - ')) {
      const parts = text.split(' - ').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const p0 = parts[0];
        const p1 = parts[1];
        const p0Lower = p0.toLowerCase();
        const p1Lower = p1.toLowerCase();
        const artistLower = cleanRawArtist.toLowerCase();

        // Rule A: Does one side contain 'ft' or 'feat'? That side is the artist!
        const hasFtP1 = /\b(ft|feat|featuring)\b/i.test(p1);
        const hasFtP0 = /\b(ft|feat|featuring)\b/i.test(p0);

        if (hasFtP1 && !hasFtP0) {
          parsedTitle = p0;
          parsedArtist = p1;
        } else if (hasFtP0 && !hasFtP1) {
          parsedTitle = p1;
          parsedArtist = p0;
        }
        // Rule B: Does p0 match the channel/artist? ('Artist - Title')
        else if (artistLower && (p0Lower.includes(artistLower) || artistLower.includes(p0Lower))) {
          parsedArtist = p0;
          parsedTitle = p1;
        }
        // Rule C: Does p1 match the channel/artist? ('Title - Artist')
        else if (artistLower && (p1Lower.includes(artistLower) || artistLower.includes(p1Lower))) {
          parsedArtist = p1;
          parsedTitle = p0;
        }
        // Default: Standard 'Artist - Title'
        else {
          parsedArtist = p0;
          parsedTitle = p1;
        }
      }
    }

    // Clean artist of publisher record label suffixes
    parsedArtist = parsedArtist
      .replace(/\b(records|record label|entertainment|films|studios)\b/gi, '')
      .trim();

    // Clean punctuation
    parsedTitle = parsedTitle.replace(/[^a-zA-Z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    parsedArtist = parsedArtist.replace(/[^a-zA-Z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();

    // Strip trailing ft from title if any
    parsedTitle = parsedTitle.replace(/\b(ft|feat)\b.*$/i, '').trim();

    // Fix ALL-CAPS (e.g. GUMAAN -> Gumaan)
    if (parsedTitle && parsedTitle === parsedTitle.toUpperCase() && parsedTitle.length > 3) {
      parsedTitle = parsedTitle.charAt(0).toUpperCase() + parsedTitle.slice(1).toLowerCase();
    }
    if (parsedArtist && parsedArtist === parsedArtist.toUpperCase() && parsedArtist.length > 3) {
      parsedArtist = parsedArtist.charAt(0).toUpperCase() + parsedArtist.slice(1).toLowerCase();
    }

    return {
      title: parsedTitle || rawTitle,
      artist: parsedArtist || rawArtist
    };
  }
}
