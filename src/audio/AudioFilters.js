export class AudioFilters {
  static getFilterArgs(filterType = 'normal', volume = 100) {
    const filters = [];

    // 1. Volume adjustment
    if (volume !== 100) {
      const volMultiplier = Math.max(0.0, Math.min(2.0, volume / 100));
      filters.push(`volume=${volMultiplier.toFixed(2)}`);
    }

    // 2. Preset audio filters
    switch (filterType.toLowerCase()) {
      case 'bassboost':
      case 'bass':
        filters.push('equalizer=f=60:width_type=h:width=50:g=12');
        break;

      case 'bass_extreme':
      case 'earrape':
        filters.push('equalizer=f=60:width_type=h:width=60:g=20,volume=1.3');
        break;

      case 'nightcore':
        filters.push('asetrate=44100*1.25,atempo=1.0');
        break;

      case 'vaporwave':
        filters.push('asetrate=44100*0.82,atempo=1.0');
        break;

      case 'slowed':
      case 'slowed_reverb':
        filters.push('asetrate=44100*0.85,atempo=1.0,aecho=0.8:0.88:60:0.4');
        break;

      case '8d':
        filters.push('apulsator=hz=0.125:amount=1');
        break;

      case 'reverb':
      case 'concert':
        filters.push('aecho=0.8:0.88:60:0.4');
        break;

      case 'echo':
        filters.push('aecho=0.8:0.9:400:0.3');
        break;

      case 'karaoke':
        filters.push('pan=stereo|c0=c0-c1|c1=c1-c0');
        break;

      case 'muffled':
      case 'underwater':
        filters.push('lowpass=f=750');
        break;

      case 'radio':
      case 'telephone':
        filters.push('highpass=f=400,lowpass=f=3200');
        break;

      case 'surround':
      case '3d':
        filters.push('stereowiden=level_in=0.8:level_out=0.8:delay=20:width=0.8');
        break;

      case 'treble':
        filters.push('equalizer=f=10000:width_type=h:width=2000:g=8');
        break;

      case 'tremolo':
        filters.push('tremolo=f=6:d=0.7');
        break;

      case 'vibrato':
        filters.push('vibrato=f=7:d=0.5');
        break;

      case 'chipmunk':
        filters.push('asetrate=44100*1.5,atempo=1.0');
        break;

      case 'normal':
      case 'off':
      case 'reset':
      default:
        break;
    }

    if (filters.length === 0) return [];
    return ['-af', filters.join(',')];
  }

  static getAvailableFilters() {
    return [
      'normal',
      'bassboost',
      'bass_extreme',
      'nightcore',
      'vaporwave',
      'slowed',
      '8d',
      'reverb',
      'echo',
      'karaoke',
      'muffled',
      'radio',
      '3d',
      'treble',
      'tremolo',
      'vibrato',
      'chipmunk'
    ];
  }
}
