from __future__ import annotations

import pdfplumber
from fastapi.testclient import TestClient

from backend.api import create_app
from tests.test_phase1_hickory_c import _load_fixture


def test_phase3_hickory_round_trip_api(tmp_path):
    app = create_app(tmp_path / "phase3.sqlite3")
    client = TestClient(app)
    hickory_c_payload = _load_fixture()

    assemblies = client.get("/api/assemblies")
    assert assemblies.status_code == 200
    assembly_rows = assemblies.json()
    assert len(assembly_rows) == 17
    assert any(
        row["code"] == "G1" and row["u_value"] == 0.35 and row["shgc"] == 0.22
        for row in assembly_rows
    )

    response = client.post("/api/projects", json=hickory_c_payload)
    assert response.status_code == 201
    project_id = response.json()["id"]

    reloaded = client.get(f"/api/projects/{project_id}")
    assert reloaded.status_code == 200
    assert reloaded.json()["project"]["description"] == "Hickory - C, Slab"

    loads = client.get(f"/api/projects/{project_id}/loads").json()
    assert loads["whole_house_sensible_cooling"] == 27870
    assert loads["whole_house_heating"] == 32477
    assert loads["system_tons"] == 3.5
    assert loads["system_kw"] == 15.0
    assert loads["system_cfm"] == 1400
    assert loads["levels"][0]["cooling_subtotal"] == 12530
    assert loads["levels"][0]["rooms"][3]["name"] == "Family"
    assert loads["levels"][0]["rooms"][3]["cfm_avg"] == 212

    report = client.get(f"/api/projects/{project_id}/report")
    assert report.status_code == 200
    assert report.headers["content-type"].startswith("application/pdf")
    assert len(report.content) > 10000

    report_path = tmp_path / "phase3_report.pdf"
    report_path.write_bytes(report.content)
    with pdfplumber.open(report_path) as pdf:
        assert len(pdf.pages) >= 3, f"Expected at least 3 pages, got {len(pdf.pages)}"
        pdf_text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    assert "27,870" in pdf_text or "27870" in pdf_text
    assert "Family" in pdf_text
    assert "Owners Bed" in pdf_text


def test_project_list_update_delete(tmp_path):
    app = create_app(tmp_path / "crud.sqlite3")
    client = TestClient(app)
    payload = _load_fixture()

    # list is empty initially
    assert client.get("/api/projects").json() == []

    # create two projects
    id1 = client.post("/api/projects", json=payload).json()["id"]
    modified = {**payload, "project": {**payload["project"], "name": "Modified"}}
    id2 = client.post("/api/projects", json=modified).json()["id"]

    listed = client.get("/api/projects").json()
    assert len(listed) == 2
    assert {p["id"] for p in listed} == {id1, id2}

    # update
    renamed = {**payload, "project": {**payload["project"], "name": "Renamed"}}
    assert client.put(f"/api/projects/{id1}", json=renamed).status_code == 200
    assert client.get(f"/api/projects/{id1}").json()["project"]["name"] == "Renamed"

    # delete
    assert client.delete(f"/api/projects/{id1}").status_code == 204
    assert client.get(f"/api/projects/{id1}").status_code == 404
    assert len(client.get("/api/projects").json()) == 1

    # 404 on missing update/delete
    assert client.put(f"/api/projects/{id1}", json=payload).status_code == 404
    assert client.delete(f"/api/projects/{id1}").status_code == 404


def test_calculate_endpoint_returns_loads_without_saving_project(tmp_path):
    app = create_app(tmp_path / "phase3_calculate.sqlite3")
    client = TestClient(app)

    response = client.post("/api/calculate", json=_load_fixture())

    assert response.status_code == 200
    loads = response.json()
    assert loads["whole_house_sensible_cooling"] == 27870
    assert loads["whole_house_heating"] == 32477
