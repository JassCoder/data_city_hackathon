from fastapi import HTTPException


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    """`minLon,minLat,maxLon,maxLat` (WGS84, longitude first); 422 when malformed."""
    try:
        parts = [float(v) for v in value.split(",")]
    except ValueError:
        parts = []
    if len(parts) != 4:
        raise HTTPException(422, "bbox must be four numbers: minLon,minLat,maxLon,maxLat")
    min_lon, min_lat, max_lon, max_lat = parts
    if not (-180 <= min_lon < max_lon <= 180 and -90 <= min_lat < max_lat <= 90):
        raise HTTPException(422, "bbox must satisfy -180 <= minLon < maxLon <= 180 and -90 <= minLat < maxLat <= 90 "
                                 "(longitude first)")
    return min_lon, min_lat, max_lon, max_lat
