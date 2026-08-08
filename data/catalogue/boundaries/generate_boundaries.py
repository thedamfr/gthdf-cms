#!/usr/bin/env python3
"""Build the deterministic PRD04 municipality-boundary snapshot.

Only Python's standard library is required. France is fetched by INSEE code from
geo.api.gouv.fr. Belgium is filtered by NIS code from the official AdminVector
WGS84 GeoPackage published by Belgium's National Geographic Institute.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import datetime as dt
import hashlib
import json
import os
import sqlite3
import struct
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


FR_ENDPOINT = "https://geo.api.gouv.fr/communes/{code}"
FR_METADATA_URL = "https://geo.api.gouv.fr/decoupage-administratif/communes"
FR_DATASET_URL = "https://www.data.gouv.fr/datasets/contours-administratifs"
BE_METADATA_URL = (
    "https://publish.geo.be/geonetwork/srv/api/records/"
    "fb1e2993-2020-428c-9188-eb5f75e284b9"
)
BE_ARCHIVE_URL = (
    "https://ac.ngi.be/remoteclient-open/ngi-standard-open/Vectordata/"
    "TerritorialDivisions/TerritorialDivisions-AdminVector/"
    "fb1e2993-2020-428c-9188-eb5f75e284b9_"
    "geopackage%2Bsqlite3_4326.zip"
)
EXPECTED_COUNTS = {"FR": 217, "BE": 6}
COORDINATE_DECIMALS = 6


class SnapshotError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
        + "\n"
    ).encode("utf-8")


def read_municipalities(csv_path: Path) -> list[dict[str, str]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    required = {"ID commune", "Pays", "Code commune", "Code INSEE", "Ville"}
    if not rows or not required.issubset(rows[0]):
        raise SnapshotError(f"CSV schema is missing {sorted(required)}")
    keys = [row["ID commune"] for row in rows]
    duplicates = sorted(key for key, count in Counter(keys).items() if count > 1)
    if duplicates:
        raise SnapshotError(f"duplicate municipality keys: {duplicates}")
    counts = Counter(row["Pays"] for row in rows)
    if dict(counts) != EXPECTED_COUNTS:
        raise SnapshotError(f"expected {EXPECTED_COUNTS}, got {dict(counts)}")
    for row in rows:
        expected_key = f"{row['Pays']}-{row['Code commune']}"
        if row["ID commune"] != expected_key:
            raise SnapshotError(
                f"key/code mismatch: {row['ID commune']} != {expected_key}"
            )
        if row["Pays"] == "FR" and row["Code INSEE"] != row["Code commune"]:
            raise SnapshotError(f"FR INSEE mismatch for {row['ID commune']}")
        if row["Pays"] == "BE" and row["Code INSEE"]:
            raise SnapshotError(f"unexpected INSEE code for {row['ID commune']}")
    return rows


def request_bytes(url: str, retries: int = 4) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/geo+json, application/json",
            "User-Agent": "gthdf-prd04-boundary-snapshot/1.0",
        },
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt + 1 == retries:
                raise SnapshotError(f"failed to download {url}: {exc}") from exc
            time.sleep(0.5 * (2**attempt))
    raise AssertionError("unreachable")


def download_file(url: str, target: Path) -> None:
    request = urllib.request.Request(
        url, headers={"User-Agent": "gthdf-prd04-boundary-snapshot/1.0"}
    )
    with urllib.request.urlopen(request, timeout=180) as response, target.open("wb") as out:
        while chunk := response.read(1024 * 1024):
            out.write(chunk)


def normalize_position(position: list[float]) -> list[float]:
    if len(position) < 2:
        raise SnapshotError(f"invalid coordinate: {position}")
    lon = round(float(position[0]), COORDINATE_DECIMALS)
    lat = round(float(position[1]), COORDINATE_DECIMALS)
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise SnapshotError(f"coordinate outside WGS84 bounds: {[lon, lat]}")
    return [lon, lat]


def normalize_ring(ring: list[list[float]]) -> list[list[float]]:
    normalized: list[list[float]] = []
    for position in ring:
        point = normalize_position(position)
        if not normalized or point != normalized[-1]:
            normalized.append(point)
    if normalized and normalized[0] != normalized[-1]:
        normalized.append(list(normalized[0]))
    if len(normalized) < 4:
        raise SnapshotError("coordinate rounding collapsed a polygon ring")
    return normalized


def normalize_geometry(geometry: dict[str, Any]) -> dict[str, Any]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        normalized = [normalize_ring(ring) for ring in coordinates]
    elif geometry_type == "MultiPolygon":
        normalized = [
            [normalize_ring(ring) for ring in polygon] for polygon in coordinates
        ]
    else:
        raise SnapshotError(f"unsupported geometry type: {geometry_type}")
    return {"type": geometry_type, "coordinates": normalized}


def fetch_fr_feature(row: dict[str, str]) -> tuple[dict[str, Any], bytes]:
    code = row["Code INSEE"]
    query = urllib.parse.urlencode(
        {
            "fields": "nom,code,codeDepartement,anciensCodes",
            "format": "geojson",
            "geometry": "contour",
        }
    )
    raw = request_bytes(f"{FR_ENDPOINT.format(code=code)}?{query}")
    try:
        source = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SnapshotError(f"invalid GeoJSON for FR-{code}") from exc
    if source.get("type") != "Feature" or source.get("properties", {}).get("code") != code:
        raise SnapshotError(f"API returned no current commune for FR-{code}")
    if not source.get("geometry"):
        raise SnapshotError(f"API returned no contour for FR-{code}")
    source_properties = source["properties"]
    feature = {
        "type": "Feature",
        "id": row["ID commune"],
        "properties": {
            "municipalityKey": row["ID commune"],
            "country": "FR",
            "adminCode": code,
            "name": row["Ville"],
            "sourceName": source_properties["nom"],
        },
        "geometry": normalize_geometry(source["geometry"]),
    }
    return feature, raw


def fetch_fr_features(
    rows: list[dict[str, str]], workers: int
) -> tuple[list[dict[str, Any]], str, list[dict[str, str]]]:
    fr_rows = sorted(
        (row for row in rows if row["Pays"] == "FR"),
        key=lambda row: row["ID commune"],
    )
    results: dict[str, tuple[dict[str, Any], bytes]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(fetch_fr_feature, row): row for row in fr_rows}
        for future in concurrent.futures.as_completed(futures):
            row = futures[future]
            results[row["ID commune"]] = future.result()

    digest = hashlib.sha256()
    features: list[dict[str, Any]] = []
    name_differences: list[dict[str, str]] = []
    for row in fr_rows:
        feature, raw = results[row["ID commune"]]
        digest.update(row["Code INSEE"].encode("ascii") + b"\0" + raw + b"\0")
        features.append(feature)
        if feature["properties"]["name"] != feature["properties"]["sourceName"]:
            name_differences.append(
                {
                    "municipalityKey": row["ID commune"],
                    "csvName": feature["properties"]["name"],
                    "sourceName": feature["properties"]["sourceName"],
                }
            )
    return features, digest.hexdigest(), name_differences


class WkbReader:
    def __init__(self, data: bytes):
        self.data = data
        self.offset = 0

    def unpack(self, fmt: str, endian: str) -> tuple[Any, ...]:
        size = struct.calcsize(endian + fmt)
        if self.offset + size > len(self.data):
            raise SnapshotError("truncated WKB geometry")
        result = struct.unpack_from(endian + fmt, self.data, self.offset)
        self.offset += size
        return result

    def geometry(self) -> dict[str, Any]:
        byte_order = self.unpack("B", "<")[0]
        if byte_order not in (0, 1):
            raise SnapshotError(f"invalid WKB byte order: {byte_order}")
        endian = "<" if byte_order == 1 else ">"
        type_code = self.unpack("I", endian)[0]
        has_z = 1000 <= type_code < 2000 or 3000 <= type_code < 4000
        has_m = 2000 <= type_code < 3000 or 3000 <= type_code < 4000
        base_type = type_code % 1000
        dimensions = 2 + int(has_z) + int(has_m)

        def point() -> list[float]:
            values = self.unpack("d" * dimensions, endian)
            return [values[0], values[1]]

        if base_type == 3:  # Polygon
            ring_count = self.unpack("I", endian)[0]
            rings = []
            for _ in range(ring_count):
                point_count = self.unpack("I", endian)[0]
                rings.append([point() for _ in range(point_count)])
            return {"type": "Polygon", "coordinates": rings}
        if base_type == 6:  # MultiPolygon
            polygon_count = self.unpack("I", endian)[0]
            polygons = []
            for _ in range(polygon_count):
                polygon = self.geometry()
                if polygon["type"] != "Polygon":
                    raise SnapshotError("MultiPolygon contains a non-Polygon member")
                polygons.append(polygon["coordinates"])
            return {"type": "MultiPolygon", "coordinates": polygons}
        raise SnapshotError(f"unsupported WKB geometry type: {type_code}")


def geometry_from_gpkg(blob: bytes) -> dict[str, Any]:
    if len(blob) < 8 or blob[:2] != b"GP":
        raise SnapshotError("invalid GeoPackage geometry header")
    flags = blob[3]
    header_endian = "<" if flags & 1 else ">"
    envelope_type = (flags >> 1) & 0b111
    envelope_bytes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}.get(envelope_type)
    if envelope_bytes is None:
        raise SnapshotError(f"unsupported GeoPackage envelope type: {envelope_type}")
    # Read SRS id to reject an unexpected source CRS before dropping the envelope.
    srs_id = struct.unpack_from(header_endian + "i", blob, 4)[0]
    if srs_id != 4326:
        raise SnapshotError(f"expected EPSG:4326 GeoPackage geometry, got {srs_id}")
    reader = WkbReader(blob[8 + envelope_bytes :])
    geometry = reader.geometry()
    if reader.offset != len(reader.data):
        raise SnapshotError("unexpected trailing bytes in WKB geometry")
    return geometry


def prepare_belgium_gpkg(source_path: Path | None, temp_dir: Path) -> tuple[Path, dict[str, Any]]:
    archive_path: Path | None = None
    if source_path is None:
        archive_path = temp_dir / "adminvector_4326.zip"
        download_file(BE_ARCHIVE_URL, archive_path)
    elif source_path.suffix.lower() == ".zip":
        archive_path = source_path
    elif source_path.suffix.lower() == ".gpkg":
        return source_path, {"archiveSha256": None, "archiveBytes": None}
    else:
        raise SnapshotError("Belgian source must be a .zip or .gpkg file")

    with zipfile.ZipFile(archive_path) as archive:
        gpkg_names = [name for name in archive.namelist() if name.endswith(".gpkg")]
        if len(gpkg_names) != 1:
            raise SnapshotError(f"expected one GeoPackage in archive, got {gpkg_names}")
        archive.extract(gpkg_names[0], temp_dir)
        gpkg_path = temp_dir / gpkg_names[0]
    return gpkg_path, {
        "archiveSha256": sha256_file(archive_path),
        "archiveBytes": archive_path.stat().st_size,
    }


def fetch_be_features(
    rows: list[dict[str, str]], gpkg_path: Path
) -> tuple[list[dict[str, Any]], str, list[dict[str, str]], str]:
    be_rows = sorted(
        (row for row in rows if row["Pays"] == "BE"),
        key=lambda row: row["ID commune"],
    )
    row_by_code = {row["Code commune"]: row for row in be_rows}
    placeholders = ",".join("?" for _ in row_by_code)
    query = (
        "SELECT niscode, namefre, namedut, nameger, modifdate, shape "
        f"FROM municipality WHERE niscode IN ({placeholders}) ORDER BY niscode"
    )
    connection = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True)
    try:
        source_rows = connection.execute(query, sorted(row_by_code)).fetchall()
        source_count = connection.execute("SELECT COUNT(*) FROM municipality").fetchone()[0]
    finally:
        connection.close()
    found_codes = {record[0] for record in source_rows}
    if found_codes != set(row_by_code):
        raise SnapshotError(
            f"Belgian NIS mismatch; missing={sorted(set(row_by_code) - found_codes)}, "
            f"extra={sorted(found_codes - set(row_by_code))}"
        )

    digest = hashlib.sha256()
    features: list[dict[str, Any]] = []
    name_differences: list[dict[str, str]] = []
    for code, name_fre, name_dut, name_ger, modified_at, blob in source_rows:
        row = row_by_code[code]
        source_name = name_fre or name_dut or name_ger
        digest.update(code.encode("ascii") + b"\0" + blob + b"\0")
        feature = {
            "type": "Feature",
            "id": row["ID commune"],
            "properties": {
                "municipalityKey": row["ID commune"],
                "country": "BE",
                "adminCode": code,
                "name": row["Ville"],
                "sourceName": source_name,
            },
            "geometry": normalize_geometry(geometry_from_gpkg(blob)),
        }
        features.append(feature)
        if row["Ville"] != source_name:
            name_differences.append(
                {
                    "municipalityKey": row["ID commune"],
                    "csvName": row["Ville"],
                    "sourceName": source_name,
                }
            )
    if source_count != 565:
        raise SnapshotError(f"expected 565 Belgian municipalities, got {source_count}")
    return features, digest.hexdigest(), name_differences, str(source_count)


def iter_positions(geometry: dict[str, Any]) -> Iterable[list[float]]:
    coordinates = geometry["coordinates"]
    if geometry["type"] == "Polygon":
        for ring in coordinates:
            yield from ring
    elif geometry["type"] == "MultiPolygon":
        for polygon in coordinates:
            for ring in polygon:
                yield from ring


def snapshot_stats(features: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "featureCount": len(features),
        "countryCounts": dict(
            sorted(Counter(f["properties"]["country"] for f in features).items())
        ),
        "geometryTypeCounts": dict(
            sorted(Counter(f["geometry"]["type"] for f in features).items())
        ),
        "coordinateCount": sum(
            1 for feature in features for _ in iter_positions(feature["geometry"])
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--csv",
        type=Path,
        required=True,
        help="Path to the controlled villes.csv dataset",
    )
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument(
        "--belgium-source",
        type=Path,
        help="Optional cached official AdminVector .zip or EPSG:4326 .gpkg",
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument(
        "--snapshot-date",
        default=dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        help="ISO-8601 retrieval date stored in the manifest",
    )
    args = parser.parse_args()
    if args.workers < 1 or args.workers > 16:
        raise SnapshotError("--workers must be between 1 and 16")

    rows = read_municipalities(args.csv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="prd04-boundaries-") as temporary:
        temp_dir = Path(temporary)
        gpkg_path, be_archive = prepare_belgium_gpkg(args.belgium_source, temp_dir)
        fr_features, fr_digest, fr_name_differences = fetch_fr_features(rows, args.workers)
        be_features, be_digest, be_name_differences, be_source_count = fetch_be_features(
            rows, gpkg_path
        )
        gpkg_sha256 = sha256_file(gpkg_path)
        gpkg_bytes = gpkg_path.stat().st_size

    features = sorted(
        fr_features + be_features,
        key=lambda feature: feature["properties"]["municipalityKey"],
    )
    keys = [feature["properties"]["municipalityKey"] for feature in features]
    expected_keys = sorted(row["ID commune"] for row in rows)
    if keys != expected_keys:
        raise SnapshotError("generated snapshot keys do not exactly match the CSV")

    snapshot = {"type": "FeatureCollection", "features": features}
    snapshot_path = args.output_dir / "municipalities.wgs84.geojson"
    snapshot_path.write_bytes(canonical_json_bytes(snapshot))
    stats = snapshot_stats(features)
    manifest = {
        "schemaVersion": 1,
        "generatedAt": args.snapshot_date,
        "snapshot": {
            "file": snapshot_path.name,
            "sha256": sha256_file(snapshot_path),
            "bytes": snapshot_path.stat().st_size,
            **stats,
            "coordinateReferenceSystem": {
                "name": "WGS 84 longitude/latitude",
                "epsg": 4326,
                "geojsonIdentifier": "OGC:CRS84",
                "axisOrder": "longitude, latitude",
            },
            "propertyOrder": [
                "municipalityKey",
                "country",
                "adminCode",
                "name",
                "sourceName",
            ],
        },
        "input": {
            "file": args.csv.name,
            "sha256": sha256_file(args.csv),
            "rowCount": len(rows),
            "countryCounts": dict(
                sorted(Counter(row["Pays"] for row in rows).items())
            ),
        },
        "sources": [
            {
                "id": "fr-geo-api-gouv-communes",
                "countries": ["FR"],
                "provider": "DINUM / Etalab",
                "dataset": "API Découpage administratif — Communes",
                "metadataUrl": FR_METADATA_URL,
                "datasetUrl": FR_DATASET_URL,
                "endpointTemplate": (
                    FR_ENDPOINT
                    + "?fields=nom,code,codeDepartement,anciensCodes"
                    + "&format=geojson&geometry=contour"
                ),
                "retrievedAt": args.snapshot_date,
                "sourceDate": (
                    "live response retrieval date; the endpoint does not expose an "
                    "upstream contour revision in its response"
                ),
                "license": {
                    "name": "Open Data Commons Open Database License",
                    "spdx": "ODbL-1.0",
                    "url": "https://opendatacommons.org/licenses/odbl/1-0/",
                    "attribution": "Contours administratifs, data.gouv.fr / Etalab",
                },
                "requestedFeatureCount": EXPECTED_COUNTS["FR"],
                "rawResponsesAggregateSha256": fr_digest,
            },
            {
                "id": "be-ngi-adminvector-municipality",
                "countries": ["BE"],
                "provider": "National Geographic Institute (NGI-IGN Belgium)",
                "dataset": "AdminVector — municipality",
                "metadataUrl": BE_METADATA_URL,
                "archiveUrl": BE_ARCHIVE_URL,
                "retrievedAt": args.snapshot_date,
                "sourceRevision": "2026-07-16",
                "edition": "Version 4.1",
                "sourceCrs": "EPSG:4326",
                "license": {
                    "name": "Creative Commons Attribution 4.0 International",
                    "spdx": "CC-BY-4.0",
                    "url": "https://creativecommons.org/licenses/by/4.0/",
                    "attribution": "National Geographic Institute (NGI-IGN Belgium), AdminVector",
                },
                "archiveSha256": be_archive["archiveSha256"],
                "archiveBytes": be_archive["archiveBytes"],
                "geoPackageSha256": gpkg_sha256,
                "geoPackageBytes": gpkg_bytes,
                "sourceMunicipalityCount": int(be_source_count),
                "requestedFeatureCount": EXPECTED_COUNTS["BE"],
                "selectedRowsAggregateSha256": be_digest,
            },
        ],
        "normalization": {
            "format": "RFC 7946 GeoJSON FeatureCollection",
            "featureOrder": "municipalityKey ascending (Unicode code-point order)",
            "coordinateDecimals": COORDINATE_DECIMALS,
            "coordinateDimensions": 2,
            "zValues": "removed",
            "consecutiveDuplicateCoordinates": "removed after rounding",
            "ringClosure": "enforced",
            "jsonEncoding": "UTF-8, compact separators, one trailing LF",
        },
        "checks": {
            "expectedMunicipalityKeys": len(expected_keys),
            "missingMunicipalityKeys": [],
            "unexpectedMunicipalityKeys": [],
            "nameDifferences": fr_name_differences + be_name_differences,
        },
    }
    manifest_path = args.output_dir / "manifest.json"
    manifest_path.write_bytes(canonical_json_bytes(manifest))
    print(
        f"wrote {snapshot_path} ({stats['featureCount']} features, "
        f"{stats['coordinateCount']} coordinates, {snapshot_path.stat().st_size} bytes)"
    )
    print(f"wrote {manifest_path}")


if __name__ == "__main__":
    main()
