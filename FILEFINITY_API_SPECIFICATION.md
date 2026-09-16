# Filefinity ↔ Onefinity CNC Control Software
# API & Integration Technical Specification

**Document Version:** 1.0.0  
**Date:** September 14, 2026  
**Status:** Proposal / Ready for Review  
**Target Audience:** Filefinity Engineering Team & Onefinity Control Software Team  

---

## 1. Executive Summary

This document specifies the integration architecture and API contracts between the **Filefinity Web Platform** (`https://main.filefinity.com`) and the **Onefinity CNC Control Software**.

The objective is to enable a frictionless **1-Click "Import to Control Software"** capability so makers and CNC operators can send toolpath files (`.ngc`, `.gcode`, `.nc`, `.tap`) directly from Filefinity into their machine sender and 3D visualizer without manual download and file management steps.

---

## 2. Integration Architecture

Two interoperable integration pathways are supported:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Filefinity Cloud Platform                         │
│                     (https://main.filefinity.com)                       │
└───────────────────┬─────────────────────────────────┬───────────────────┘
                    │                                 │
     Method A: Cloud REST API             Method B: Web-to-Local Bridge
     (In-App Filefinity Browser)          ("Import to Control Software" Button)
                    │                                 │
                    ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Onefinity CNC Control Software                      │
│                  Local Controller Server: http://localhost:4000         │
│                  Frontend UI: http://localhost:3000                     │
│                                                                         │
│   • 3D Toolpath Visualizer (Three.js WebGL Engine)                      │
│   • Multi-Axis Motion Control (X, Y, Z, A Rotary)                       │
│   • Persistent Custom Library Storage (backend/data/library/)           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Method A: Filefinity Cloud REST API (In-App Flow)
*(Endpoints hosted on Filefinity servers for third-party CNC software)*

### 3.1 Authentication

#### `POST /api/v1/auth/token`
Exchange an authorization code or user credentials for a scoped Bearer token.

* **Headers:**
  ```http
  Content-Type: application/json
  Accept: application/json
  ```
* **Request Body:**
  ```json
  {
    "grant_type": "authorization_code",
    "client_id": "onefinity_cnc_controller",
    "client_secret": "CLIENT_SECRET_KEY",
    "code": "AUTH_CODE_FROM_USER_OAUTH_LOGIN",
    "redirect_uri": "http://localhost:4000/api/auth/filefinity/callback"
  }
  ```
* **Response `200 OK`:**
  ```json
  {
    "access_token": "ff_live_token_8f9e0a1b2c3d4e5f",
    "token_type": "Bearer",
    "expires_in": 2592000,
    "user": {
      "id": "usr_99214",
      "username": "cnc_artisan"
    }
  }
  ```

---

### 3.2 Model & Attachments Metadata

#### `GET /api/v1/models/{modelId}`
Retrieve project information and all downloadable attachments (categorized by type).

* **Path Parameters:**
  * `modelId` *(string, required)*: e.g., `6a9fed70af386fe917fce2f0`
* **Headers:**
  ```http
  Authorization: Bearer <access_token>
  Accept: application/json
  ```
* **Response `200 OK`:**
  ```json
  {
    "status": "success",
    "data": {
      "id": "6a9fed70af386fe917fce2f0",
      "title": "Buildbotics Dragon",
      "author": {
        "id": "usr_8812",
        "name": "Onefinity Community Creator"
      },
      "license": "CC-BY-SA-4.0",
      "thumbnailUrl": "https://cdn.filefinity.com/thumbnails/6a9fed70.jpg",
      "attachments": [
        {
          "id": "att_001",
          "name": "Buildbotics_DRAGON ROUGH.ngc",
          "category": "gcode",
          "format": "ngc",
          "sizeBytes": 2451000,
          "estimatedTimeMinutes": 45,
          "downloadUrl": "https://cdn.filefinity.com/files/6a9fed/att_001/download?token=SIGNED_TEMP_TOKEN"
        },
        {
          "id": "att_002",
          "name": "Buildbotics_DRAGON FINISH.ngc",
          "category": "gcode",
          "format": "ngc",
          "sizeBytes": 5120000,
          "estimatedTimeMinutes": 120,
          "downloadUrl": "https://cdn.filefinity.com/files/6a9fed/att_002/download?token=SIGNED_TEMP_TOKEN"
        },
        {
          "id": "att_003",
          "name": "Dragon_Model_Vector.dxf",
          "category": "cad",
          "format": "dxf",
          "sizeBytes": 890000,
          "downloadUrl": "https://cdn.filefinity.com/files/6a9fed/att_003/download?token=SIGNED_TEMP_TOKEN"
        }
      ]
    }
  }
  ```

---

### 3.3 File Download Stream

#### `GET /api/v1/attachments/{attachmentId}/download`
Stream the raw ASCII G-code file contents.

* **Headers:**
  ```http
  Authorization: Bearer <access_token>
  ```
* **Response `200 OK`:**
  * `Content-Type: text/plain; charset=utf-8`
  * `Content-Disposition: attachment; filename="Buildbotics_DRAGON ROUGH.ngc"`
  * **Payload:** Raw G-code program data.

---

## 4. Method B: Onefinity Local API Bridge (Web-to-Sender Flow)
*(Endpoint hosted locally on the Onefinity Controller at `http://localhost:4000`)*

When the user clicks the green **`[ 📥 Import to Control Software ]`** button on the Filefinity website, Filefinity dispatches the file to this local endpoint.

### 4.1 Local Receiver Endpoint

#### `POST http://localhost:4000/api/external/import`

* **CORS Support:**
  * Allowed Origins: `https://main.filefinity.com`, `https://filefinity.com`
  * Allowed Methods: `POST, OPTIONS`
  * Allowed Headers: `Content-Type, Authorization`

* **Request Schema (JSON):**
  ```json
  {
    "source": "filefinity",
    "modelId": "6a9fed70af386fe917fce2f0",
    "modelTitle": "Buildbotics Dragon",
    "fileName": "Buildbotics_DRAGON ROUGH.ngc",
    "downloadUrl": "https://cdn.filefinity.com/files/6a9fed/att_001/download?token=SIGNED_TEMP_TOKEN",
    "fileBody": "(Optional: Raw G-code string if transferring without URL fetch)",
    "autoLoad": true
  }
  ```

* **Field Specifications:**
  | Field | Type | Required | Description |
  |---|---|---|---|
  | `source` | `string` | **Yes** | Constant string `"filefinity"`. |
  | `modelId` | `string` | **Yes** | Filefinity model/project identifier. |
  | `modelTitle` | `string` | Optional | Name of the project displayed in sender library. |
  | `fileName` | `string` | **Yes** | File name including extension (`.ngc`, `.gcode`, `.nc`, `.tap`). |
  | `downloadUrl` | `string` | **Conditional** | Public/Signed download URL. (Required if `fileBody` is omitted). |
  | `fileBody` | `string` | **Conditional** | Direct G-code string payload. (Required if `downloadUrl` is omitted). |
  | `autoLoad` | `boolean` | Optional | If `true`, immediately renders into 3D visualizer. Default: `true`. |

* **Response `200 OK`:**
  ```json
  {
    "success": true,
    "message": "File successfully imported and loaded into Onefinity sender",
    "file": {
      "id": "lib_6a9fed70_001",
      "name": "Buildbotics_DRAGON ROUGH",
      "fileName": "Buildbotics_DRAGON ROUGH.ngc",
      "size": 2451000,
      "lines": 48210
    }
  }
  ```

* **Error Status Codes:**
  * `400 Bad Request`: Missing file name or invalid G-code format.
  * `502 Bad Gateway`: Controller could not reach `downloadUrl` to fetch stream.

---

### 4.2 Web Integration Snippet for Filefinity Frontend

Filefinity engineers can attach this snippet to the **`[ 📥 Import to Control Software ]`** button:

```javascript
/**
 * Dispatch attachment to local Onefinity Control Software
 * @param {Object} model - Filefinity Model metadata
 * @param {Object} attachment - Selected attachment object
 */
async function importToControlSoftware(model, attachment) {
  const LOCAL_ENDPOINT = 'http://localhost:4000/api/external/import';

  const payload = {
    source: 'filefinity',
    modelId: model.id,
    modelTitle: model.title,
    fileName: attachment.name,
    downloadUrl: attachment.downloadUrl,
    autoLoad: true
  };

  try {
    const res = await fetch(LOCAL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    
    // UI Feedback
    showNotification({
      type: 'success',
      message: `"${attachment.name}" sent to Onefinity CNC Controller!`
    });
  } catch (err) {
    console.warn('[Filefinity] Local Onefinity sender unreachable:', err);
    
    // Fallback: Trigger standard browser file download
    window.location.href = attachment.downloadUrl;
  }
}
```

---

### 4.3 Deep Link URI Scheme (Optional Fallback)

If browser security policies prevent HTTPS-to-HTTP localhost calls, a standard custom OS protocol handler is supported:

```
onefinity://import?source=filefinity&modelId=6a9fed70af386fe917fce2f0&fileName=Buildbotics_DRAGON_ROUGH.ngc&downloadUrl=https%3A%2F%2Fcdn.filefinity.com%2Ffiles%2F...
```

---

## 5. Supported CNC File Formats & Validation

The Onefinity parser automatically checks and supports:
* `.ngc` — Native LinuxCNC / Buildbotics / Onefinity format
* `.gcode` — Standard ISO/RS274 G-code
* `.nc` — Numerical Control format
* `.tap` — Mach3 / CAM toolpaths
* `.cnc` — General CNC export

---

## 6. Technical Contact & Sandbox Support

* **Local Controller Staging Ports:**
  * Backend API: `http://localhost:4000`
  * Frontend Web App: `http://localhost:3000`
* **Test Verification Endpoint:** `POST /api/external/import`
