# Data sources

SkyRoute Warsaw is a planning and simulation prototype. **No data in this repository establishes real-world flight legality.** Before any real flight, check the current zones in PAŻP DroneTower or DroneMap.

## Summary

| Data | Source | Type | Where |
|---|---|---|---|
| **City boundary + 18 districts** | **GUGiK – Państwowy Rejestr Granic (PRG)**, OGC API Features | Official, cached snapshot (2026-10-17) | `data/boundaries/warsaw_city.geojson`, `warsaw_districts.geojson` (`scripts/fetch_boundaries.py`) |
| Buildings (height), river, parks | © OpenStreetMap contributors (ODbL), via Overpass API | Real citywide snapshot (2026-10-17): 189,276 buildings | `data/osm/grid_warsaw_25m.npz` (routing raster), `data/osm/tiles/14/…` (display), `data/corridors.geojson`, `data/tall_buildings.geojson` (`scripts/fetch_osm.py`) |
| **UAS geographical zones** | **SkyRoute DEMO dataset** | **Synthetic, non-authoritative** | `data/airspace/demo_zones.geojson` (`scripts/build_demo_data.py`) |
| Landing stations | SkyRoute DEMO | Synthetic | `data/landing_stations.geojson` |
| Drone profiles | SkyRoute DEMO | Illustrative assumptions | `data/drone_profiles.json` |
| Address search | Nominatim (© OpenStreetMap contributors) | Live, server-side, at most 1 request/s, cached 24 h | `backend/app/services/geocoding.py` |
| Wind (LIVE mode) | Open-Meteo | Live, with an explicit DEMO fallback | `backend/app/services/weather.py` |
| Map tiles | © OpenStreetMap contributors | Live tiles | frontend |

## Warsaw administrative boundary

- **Source:** GUGiK's national register of boundaries (PRG), through its documented public OGC API Features service: `https://ogcapi.geoportal.gov.pl/res/ims/maps/PRG/apiFeatures/collections`.
- **How features are selected:** by **TERYT code**, not by name.
  - The city: collection `GranicaPowiatu`, `kod == "1465"` ("powiat Warszawa", a city with county rights, 516.7 km²).
  - The 18 districts: collection `GranicaJednostkiEwidencyjnej`, `kod` `146502_8` … `146519_8`.
  - This cannot be confused with neighbouring counties (warszawski zachodni, 1432) or the metropolitan area.
- **Checks:** the script refuses to write unless it finds exactly 1 city and 18 districts whose union matches the city area within 1%.
- **Use:** the city polygon is the routing coverage. Every point is validated against it with a point-in-polygon test, on both the backend and the frontend.
- **Metadata kept:** the PRG version id, the "valid from" date and the retrieval time.

## Polish UAS geographical zones: what official data is available

This research was carried out on 2026-10-17. The goal was a documented, permitted, machine-readable source of Polish UAS geographical zones (DRA-P/R/T/U/I).

| Checked | Finding |
|---|---|
| [pansa.pl/strefy-geograficzne](https://www.pansa.pl/strefy-geograficzne/) | Defines the zone types (see below). Points pilots to DroneTower and DroneMap for viewing. **No dataset, API, ED-269/ED-318 file or data-access terms.** |
| [pansa.pl/dane](https://www.pansa.pl/dane/) ("Dane", PAŻP data products) | Lists radar data, meteorological data (Chopin airport) and flight statistics. **No UAS zone dataset.** Access is by contact with PAŻP (info@pansa.pl). |
| [dronemap.pansa.pl](https://dronemap.pansa.pl/) | A JavaScript map application. It loads zone data from a backend (`api.dronemap.pansa.pl`) that PAŻP **does not publicly document**, and no terms for third-party use were found. A community QGIS plugin ("PANSA DroneMap Downloader") calls that backend, but it is not a PAŻP product. **Not used:** calling an undocumented service would break this project's data rules. |
| [airspace.pansa.pl](https://airspace.pansa.pl/) | AUP/UUP (airspace use plan) viewer. **No documented API or download.** |
| [drony.gov.pl](https://www.drony.gov.pl/) | Drone portal (DSS, mission planning). **No zone datasets or API mentioned.** |
| EU context | Regulation (EU) 2019/947 Art. 15 requires states to publish geographical zones in a common digital format (EUROCAE ED-269, now ED-318). A third-party survey ([unmannedairspace.info](https://www.unmannedairspace.info/uncategorized/just-eleven-european-countries-publish-uas-geo-zone-information-in-correct-format/)) did not list Poland among countries that publish a usable file. This was not independently confirmed. |

**Result:**
- No documented, permitted official API or downloadable zone file was found.
- **No official API integration was attempted or succeeded.**
- The app uses the clearly labelled DEMO provider.

### Zone categories (from PAŻP)

| Category | Meaning (PAŻP) | SkyRoute default for a simulated flight |
|---|---|---|
| DRA-P | Prohibited: only narrowly defined state services, under PAŻP conditions | **Blocked** (RED) |
| DRA-R | Restricted: flights need consent and conditions from PAŻP or the zone requester | **Unavailable** without a recorded authorization (ORANGE, routing obstacle) |
| DRA-RH / RM / RL | Restricted, with a *high / medium / low likelihood* of consent being granted | Same as DRA-R. The likelihood is shown, never treated as permission. |
| DRA-T | Technical requirements for the UAS; consent may also be required | **Unavailable** unless the requirements are verified (YELLOW, routing obstacle) |
| DRA-U | U-space: operations only with verified U-space services | **Unavailable** (ORANGE, routing obstacle) |
| DRA-I | Information, including navigation warnings | **Warning only** (YELLOW). Blocks only if its restriction type independently requires it. |
| Unknown / incomplete | | **Treated as blocked** (GRAY) |

Each zone is evaluated for the planned flight:
- **Validity period:** a zone outside its period is inactive. An unknown period means active.
- **Altitude band:** the zone band is compared with the cruise altitude ± 10 m, or from the ground up at take-off and landing. An unknown limit means unlimited on that side. AMSL limits are compared using a terrain range of 75–120 m AMSL (no DEM).
- **Category:** applied as in the table above.

## What is needed for official data

1. **Permission and a dataset from PAŻP:** a machine-readable export of the UAS geographical zones for the Warsaw area, ideally ED-269/ED-318 JSON, with licence or terms that allow use in this application. It must state its currency (issue date, update cycle). Contact: info@pansa.pl, [pansa.pl/drony-kontakt](https://www.pansa.pl/drony-kontakt/), or the [PAŻP help centre](https://pansa.atlassian.net/servicedesk/customer/portals).
2. **Or a documented API** with terms of use and credentials. A live provider would then be added next to the file providers. No credentials are needed today, because no such API is published.
3. **For time-limited zones** (for example temporary reservations): activation data (AUP/UUP) through an authorized channel. Without it, SkyRoute treats a zone as active for its whole validity period.

### Plugging in an official file

```bash
# ED-269-style JSON export
SKYROUTE_AIRSPACE_PROVIDER=ed269   SKYROUTE_AIRSPACE_FILE=/path/to/pansa_zones.json
# or a file already converted to SkyRoute's normalized GeoJSON (see app/airspace/models.py)
SKYROUTE_AIRSPACE_PROVIDER=geojson SKYROUTE_AIRSPACE_FILE=/path/to/zones.geojson
```

The data is marked `PERMITTED_SNAPSHOT` and `OFFICIAL_UNVERIFIED_LOCALLY`, and the UI shows it as "Official snapshot (permitted file)". If the file changes while the server runs, it is reloaded on the next request, and routes planned on the old version are marked outdated. If an update is broken, the server keeps the last good version.

ED-269 mapping (`Ed269FileProvider`):

| ED-269 field | SkyRoute field |
|---|---|
| `restriction` | `restrictionType`: `PROHIBITED`, `REQ_AUTHORISATION` → `AUTHORIZATION_REQUIRED`, `CONDITIONAL`, `NO_RESTRICTION` → `INFORMATION` |
| A `DRA-x` label in `name`, `identifier`, `otherReasonInfo` or `message` | `draCategory` (otherwise `UNKNOWN`) |
| Volumes | Merged into one envelope: lowest floor and highest ceiling. Feet are converted to metres. |
| `Circle` (`center` + `radius`) | A 128-vertex geodesic polygon, with the original circle kept |
| `applicability` | Validity start and end (schedules are noted, not evaluated) |

**Caveat:** this mapping follows the ED-269 structure but has **not** been checked against a real PAŻP file, because none was available. Review it when the file arrives. Vertical references other than AGL or AMSL become `UNKNOWN`, which conservatively means the zone applies at every altitude.

## DEMO airspace dataset

`data/airspace/demo_zones.geojson` is invented for the prototype. It declares an **extent** (central Warsaw) in its metadata. Routes that leave that extent are reported with the length "not checked against any zones", because there are no DEMO zones for the rest of the city, and none are invented around airports or other sites.
- Every zone has `sourceType: "DEMO"`, `verificationStatus: "SYNTHETIC_DEMO"`, an id starting `DEMO-` and "DEMO" in its name.
- The map shows a "DEMO airspace: synthetic zones, not official PAŻP boundaries" banner, a DEMO badge in every zone popup, and the source in the legend and route results.

The dataset covers every category and evaluation path:
- DRA-P polygons (Sejm) and a DRA-P circle with an AMSL ceiling (Royal Castle).
- DRA-RM (Palace of Culture).
- Three DRA-RH school circles limited to 0–60 m AGL.
- DRA-T, DRA-U and DRA-I areas.
- An expired temporary DRA-RL zone.

The locations echo real places so the demo reads naturally. **The boundaries, categories and limits are not the official ones.**
