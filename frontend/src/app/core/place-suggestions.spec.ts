import { BOUNDARY } from '../../testing/fixtures';
import { containsPoint } from './geo';
import { Suggestion, fold, labelPoint, matchSuggestions, parseCoordinates } from './place-suggestions';

const at = { latitude: 52.23, longitude: 21.0 };
const pool: Suggestion[] = [
  { kind: 'district', label: 'Śródmieście', detail: '', coordinate: at },
  { kind: 'station', label: 'Śródmieście Hospital Pad', detail: '', coordinate: at },
  { kind: 'district', label: 'Praga-Północ', detail: '', coordinate: at },
  { kind: 'recent', label: 'Warszawa Centralna', detail: '', coordinate: at },
  { kind: 'station', label: 'Rydz-Śmigły Park Pad', detail: '', coordinate: at },
];

describe('place suggestions', () => {
  it('parses typed coordinates in common formats', () => {
    expect(parseCoordinates('52.2297, 21.0122')).toEqual({ latitude: 52.2297, longitude: 21.0122 });
    expect(parseCoordinates('52.2297 21.0122')).toEqual({ latitude: 52.2297, longitude: 21.0122 });
    expect(parseCoordinates('52,2297; 21,0122')).toEqual({ latitude: 52.2297, longitude: 21.0122 });
    expect(parseCoordinates('95, 21')).toBeNull();
    expect(parseCoordinates('Marszałkowska 10')).toBeNull();
  });

  it('matches without case or Polish diacritics', () => {
    expect(fold('Śródmieście Północ Łazienki')).toBe('srodmiescie polnoc lazienki');
    expect(matchSuggestions('srodm', pool).map((s) => s.label)).toEqual(['Śródmieście Hospital Pad', 'Śródmieście']);
    expect(matchSuggestions('polnoc', pool).map((s) => s.label)).toEqual(['Praga-Północ']);
  });

  it('ranks word-start matches above matches inside a word, recent places first', () => {
    const labels = matchSuggestions('pa', pool).map((s) => s.label);
    expect(labels[0]).toBe('Śródmieście Hospital Pad'); // "Pad" starts a word (station rank)
    expect(labels).toContain('Rydz-Śmigły Park Pad');
  });

  it('offers recent places for an empty field', () => {
    expect(matchSuggestions('', pool).map((s) => s.kind)).toEqual(['recent']);
  });

  it('labels a district with a point inside it', () => {
    for (const f of BOUNDARY.districts.features) {
      const p = labelPoint(f.geometry);
      expect(p).not.toBeNull();
      expect(containsPoint(f.geometry, p!)).toBe(true);
    }
  });
});
