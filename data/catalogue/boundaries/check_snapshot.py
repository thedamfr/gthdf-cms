#!/usr/bin/env python3
"""Offline integrity check, with optional dataset coverage, for the PRD04 snapshot."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


EXPECTED_COUNTS = {"BE": 6, "FR": 217}


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_expected(csv_path: Path) -> dict[str, dict[str, str]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    expected = {row["ID commune"]: row for row in rows}
    if len(expected) != len(rows):
        fail("duplicate municipality keys in villes.csv")
    if Counter(row["Pays"] for row in rows) != Counter(EXPECTED_COUNTS):
        fail(f"unexpected country counts in villes.csv: {Counter(row['Pays'] for row in rows)}")
    return expected


def polygon_rings(geometry: dict[str, Any]) -> Iterable[list[list[float]]]:
    if geometry.get("type") == "Polygon":
        yield from geometry.get("coordinates", [])
    elif geometry.get("type") == "MultiPolygon":
        for polygon in geometry.get("coordinates", []):
            yield from polygon
    else:
        fail(f"unsupported geometry type: {geometry.get('type')}")


def check_geometry(key: str, geometry: dict[str, Any]) -> int:
    coordinate_count = 0
    rings = list(polygon_rings(geometry))
    if not rings:
        fail(f"{key}: empty geometry")
    for ring in rings:
        if len(ring) < 4:
            fail(f"{key}: polygon ring has fewer than four positions")
        if ring[0] != ring[-1]:
            fail(f"{key}: polygon ring is not closed")
        previous = None
        for position in ring:
            coordinate_count += 1
            if not isinstance(position, list) or len(position) != 2:
                fail(f"{key}: coordinates must be two-dimensional arrays")
            lon, lat = position
            if not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
                fail(f"{key}: non-numeric coordinate")
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                fail(f"{key}: coordinate outside WGS84 bounds: {position}")
            if previous is not None and position == previous:
                fail(f"{key}: consecutive duplicate coordinate")
            previous = position
    return coordinate_count


def point_in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for index in range(len(ring) - 1):
        x1, y1 = ring[index]
        x2, y2 = ring[index + 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def point_in_geometry(point: tuple[float, float], geometry: dict[str, Any]) -> bool:
    polygons = (
        [geometry["coordinates"]]
        if geometry["type"] == "Polygon"
        else geometry["coordinates"]
    )
    return any(
        point_in_ring(point, polygon[0])
        and not any(point_in_ring(point, hole) for hole in polygon[1:])
        for polygon in polygons
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        type=Path,
        help=(
            "Optional villes.csv path. When provided, also checks its SHA-256, "
            "exact municipality coverage, properties and anchors."
        ),
    )
    parser.add_argument("--snapshot-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()

    expected = read_expected(args.csv) if args.csv is not None else None
    manifest_path = args.snapshot_dir / "manifest.json"
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    snapshot_path = args.snapshot_dir / manifest["snapshot"]["file"]
    if sha256_file(snapshot_path) != manifest["snapshot"]["sha256"]:
        fail("snapshot SHA-256 does not match manifest")
    if snapshot_path.stat().st_size != manifest["snapshot"]["bytes"]:
        fail("snapshot byte count does not match manifest")
    if args.csv is not None and sha256_file(args.csv) != manifest["input"]["sha256"]:
        fail("villes.csv SHA-256 does not match manifest")

    with snapshot_path.open("r", encoding="utf-8") as handle:
        snapshot = json.load(handle)
    if snapshot.get("type") != "FeatureCollection":
        fail("snapshot is not a GeoJSON FeatureCollection")
    features = snapshot.get("features", [])
    keys = [feature.get("properties", {}).get("municipalityKey") for feature in features]
    if not all(isinstance(key, str) and key for key in keys):
        fail("missing or invalid municipalityKey in snapshot")
    if keys != sorted(keys):
        fail("features are not sorted by municipalityKey")
    if len(keys) != len(set(keys)):
        fail("duplicate municipalityKey in snapshot")
    if expected is not None:
        missing = sorted(set(expected) - set(keys))
        unexpected = sorted(set(keys) - set(expected))
        if missing or unexpected:
            fail(f"coverage mismatch: missing={missing}, unexpected={unexpected}")

    country_counts: Counter[str] = Counter()
    geometry_counts: Counter[str] = Counter()
    coordinate_count = 0
    expected_property_order = manifest["snapshot"]["propertyOrder"]
    for feature in features:
        properties = feature.get("properties", {})
        key = properties["municipalityKey"]
        if feature.get("type") != "Feature" or feature.get("id") != key:
            fail(f"{key}: invalid feature type or id")
        if list(properties) != expected_property_order:
            fail(f"{key}: property order/schema mismatch")
        if key != f"{properties['country']}-{properties['adminCode']}":
            fail(f"{key}: municipalityKey does not match country/adminCode")
        if not properties["name"]:
            fail(f"{key}: missing name")
        if not properties["sourceName"]:
            fail(f"{key}: missing sourceName")
        if expected is not None:
            row = expected[key]
            expected_code = (
                row["Code INSEE"] if row["Pays"] == "FR" else row["Code commune"]
            )
            expected_properties = {
                "municipalityKey": key,
                "country": row["Pays"],
                "adminCode": expected_code,
                "name": row["Ville"],
            }
            for property_name, expected_value in expected_properties.items():
                if properties[property_name] != expected_value:
                    fail(
                        f"{key}: {property_name}={properties[property_name]!r}, "
                        f"expected {expected_value!r}"
                    )
            anchor = (float(row["Longitude ancre"]), float(row["Latitude ancre"]))
            if not point_in_geometry(anchor, feature["geometry"]):
                fail(f"{key}: CSV municipality anchor is outside the source contour")
        country_counts[properties["country"]] += 1
        geometry_counts[feature["geometry"]["type"]] += 1
        coordinate_count += check_geometry(key, feature["geometry"])

    stats = manifest["snapshot"]
    actual_country_counts = dict(sorted(country_counts.items()))
    actual_geometry_counts = dict(sorted(geometry_counts.items()))
    if len(features) != stats["featureCount"]:
        fail("feature count does not match manifest")
    if actual_country_counts != stats["countryCounts"] or actual_country_counts != EXPECTED_COUNTS:
        fail(f"country counts do not match: {actual_country_counts}")
    if actual_geometry_counts != stats["geometryTypeCounts"]:
        fail(f"geometry counts do not match: {actual_geometry_counts}")
    if coordinate_count != stats["coordinateCount"]:
        fail(f"coordinate count does not match: {coordinate_count}")
    if manifest["input"]["rowCount"] != len(features):
        fail("input row count does not match snapshot feature count")
    if manifest["checks"]["expectedMunicipalityKeys"] != len(features):
        fail("expected municipality key count does not match snapshot feature count")

    summary = (
        "OK: "
        f"{len(features)} municipality keys ({country_counts['FR']} FR, {country_counts['BE']} BE), "
    )
    if expected is not None:
        summary += f"{len(features)} anchors inside contours, "
    summary += f"{coordinate_count} WGS84 coordinates, sha256={stats['sha256']}"
    if expected is None:
        summary += " (snapshot-only; pass --csv to check dataset coverage and anchors)"
    print(summary)


if __name__ == "__main__":
    main()
