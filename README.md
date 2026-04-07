# AR Weather Overlay App

A lightweight browser-based augmented reality weather overlay app that opens the device camera, displays a small AR-style 3D overlay, and shows live weather (temperature + humidity) for the user’s current location.

Designed for deployment on **Render** and testing in **mobile Chrome / desktop browsers**.

---

## Features

- **Live camera preview**
- **AR-style overlay panel** positioned over the camera feed
- **3D placeholder model** rendered in overlay
- **Rotate model** with one-finger drag
- **Scale model** with pinch gesture
- **Tap outside overlay** to close it
- **Switch camera** (front/back)
- **Weather lookup** using current device latitude/longitude
- **Humidity display**
- **Cached weather fallback**
- **Approximate location badge** when GPS precision is low
- **Friendly weather failure message**
- **No “API limit” text shown to users**

---

## Tech Stack

- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Backend:** Node.js + Express
- **Weather API:** Open-Meteo
- **Hosting:** Render

---

## Project Structure

```txt
.
├── index.html
├── styles.css
├── app.bundle.js
├── package.json
├── render.yaml
├── README.md
├── .gitignore
└── server/
    └── index.js