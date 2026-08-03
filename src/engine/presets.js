import { emit, ui } from './host.js';
import { syncEnvUniforms, syncGrassUniforms, syncGroundUniforms } from './field.js';
import { Dens, rebuildBladeTemplate } from './grass.js';
import { markSceneDirty } from './persistence.js';
import { deepMerge, state } from './state.js';

/* ==========================================================================
   11. PRESETS
   ========================================================================== */
export var PRESETS = [
  {
    name: 'Lawn', swatch: '#5f9d33',
    grass: { height: 0.55, heightVar: 0.22, width: 0.05, widthVar: 0.2, taper: 1.15,
             curve: 0.34, curveVar: 0.3, segments: 4, bladeCurl: 0.5,
             baseColor: '#2b5720', tipColor: '#79bd3f', gradPow: 1.6,
             hueVar: 0.03, satVar: 0.14, valVar: 0.18, density: 1,
             stiffMin: 0.9, stiffMax: 1.7, ao: 0.6, translucency: 0.75,
             specular: 0.18, roughness: 0.62 },
    wind: { strength: 0.28, direction: 40, speed: 0.3, turbulence: 0.4,
            waveScale: 0.12, gustFreq: 0.22, gustStrength: 0.5, gustSpeed: 1.7 },
    plate: { pattern: 'checker', baseColor: '#3e4436', secColor: '#333a2c',
             checkerScale: 2.5, grid: false, gridOpacity: 0.2, roughness: 0.85 },
    env: { timeOfDay: 14.5, exposure: 1.05, fogDensity: 0.006, fogAuto: true,
           shadows: true, shadowStrength: 0.5 },
    brush: { maxDensity: 190, scatter: 0.35, tilt: 0.1 }
  },
  {
    name: 'Wild Meadow', swatch: '#8bbd4e',
    grass: { height: 1.35, heightVar: 0.55, width: 0.062, widthVar: 0.35, taper: 0.95,
             curve: 0.72, curveVar: 0.6, segments: 6, bladeCurl: 0.6,
             baseColor: '#2f5a1d', tipColor: '#a6cf5c', gradPow: 1.4,
             hueVar: 0.08, satVar: 0.26, valVar: 0.3, density: 1,
             stiffMin: 0.45, stiffMax: 1.5, ao: 0.66, translucency: 1.15,
             specular: 0.22, roughness: 0.58 },
    wind: { strength: 0.62, direction: 62, speed: 0.38, turbulence: 0.78,
            waveScale: 0.07, gustFreq: 0.16, gustStrength: 0.95, gustSpeed: 1.5 },
    plate: { pattern: 'noise', baseColor: '#3a3f30', secColor: '#4a4433',
             checkerScale: 3.2, grid: false, roughness: 0.9 },
    env: { timeOfDay: 17.6, exposure: 1.1, fogDensity: 0.009, fogAuto: true,
           shadows: true, shadowStrength: 0.55 },
    brush: { maxDensity: 120, scatter: 1, tilt: 0.28 }
  },
  {
    name: 'Dry Savanna', swatch: '#c9a957',
    grass: { height: 1.7, heightVar: 0.6, width: 0.05, widthVar: 0.3, taper: 0.8,
             curve: 0.95, curveVar: 0.55, segments: 6, bladeCurl: 0.45,
             baseColor: '#6a5a26', tipColor: '#d8c078', gradPow: 1.15,
             hueVar: 0.05, satVar: 0.3, valVar: 0.3, density: 0.82,
             stiffMin: 0.35, stiffMax: 1.1, ao: 0.58, translucency: 1.35,
             specular: 0.3, roughness: 0.5 },
    wind: { strength: 0.85, direction: 108, speed: 0.5, turbulence: 0.85,
            waveScale: 0.055, gustFreq: 0.12, gustStrength: 1.35, gustSpeed: 2.1 },
    plate: { pattern: 'noise', baseColor: '#6b5a3c', secColor: '#87724a',
             checkerScale: 4, grid: false, roughness: 0.95 },
    env: { timeOfDay: 18.4, exposure: 1.15, fogDensity: 0.011, fogAuto: true,
           shadows: true, shadowStrength: 0.6 },
    brush: { maxDensity: 85, scatter: 1, tilt: 0.32 }
  },
  {
    name: 'Wheat Field', swatch: '#dcb64e',
    grass: { height: 2.35, heightVar: 0.24, width: 0.038, widthVar: 0.2, taper: 0.6,
             curve: 1.15, curveVar: 0.3, segments: 7, bladeCurl: 0.35,
             baseColor: '#8a7326', tipColor: '#efd583', gradPow: 1.9,
             hueVar: 0.03, satVar: 0.2, valVar: 0.24, density: 1,
             stiffMin: 0.7, stiffMax: 1.1, ao: 0.7, translucency: 1.5,
             specular: 0.4, roughness: 0.42 },
    wind: { strength: 0.72, direction: 22, speed: 0.26, turbulence: 0.42,
            waveScale: 0.032, gustFreq: 0.085, gustStrength: 1.5, gustSpeed: 1.15 },
    plate: { pattern: 'solid', baseColor: '#6d5c33', secColor: '#5a4c2b',
             grid: false, roughness: 0.92 },
    env: { timeOfDay: 17.1, exposure: 1.12, fogDensity: 0.008, fogAuto: true,
           shadows: true, shadowStrength: 0.5 },
    brush: { maxDensity: 150, scatter: 0.75, tilt: 0.12 }
  },
  {
    name: 'Alien / Neon', swatch: '#3fe0c8',
    grass: { height: 1.5, heightVar: 0.5, width: 0.085, widthVar: 0.4, taper: 1.5,
             curve: 0.85, curveVar: 0.7, segments: 7, bladeCurl: 1.1,
             baseColor: '#0f3a56', tipColor: '#54ffe0', gradPow: 1.1,
             hueVar: 0.16, satVar: 0.4, valVar: 0.35, density: 0.95,
             stiffMin: 0.3, stiffMax: 1.8, ao: 0.5, translucency: 2.1,
             specular: 0.85, roughness: 0.22 },
    wind: { strength: 0.68, direction: 200, speed: 0.55, turbulence: 1.1,
            waveScale: 0.11, gustFreq: 0.26, gustStrength: 1.1, gustSpeed: 2.6 },
    plate: { pattern: 'radial', baseColor: '#121a2c', secColor: '#2a1240',
             checkerScale: 2, grid: true, gridSpacing: 2, gridOpacity: 0.45, roughness: 0.3 },
    env: { timeOfDay: 18.35, exposure: 1.9, fogDensity: 0.012, fogAuto: false,
           fogColor: '#2a1b4a', shadows: true, shadowStrength: 0.4 },
    brush: { maxDensity: 100, scatter: 1, tilt: 0.35 }
  },
  {
    name: 'Snow-dusted', swatch: '#cfdbe4',
    grass: { height: 0.8, heightVar: 0.45, width: 0.055, widthVar: 0.3, taper: 1.0,
             curve: 0.7, curveVar: 0.55, segments: 5, bladeCurl: 0.5,
             baseColor: '#3f4d3f', tipColor: '#dfe9ef', gradPow: 2.4,
             hueVar: 0.02, satVar: 0.16, valVar: 0.2, density: 0.9,
             stiffMin: 0.8, stiffMax: 1.9, ao: 0.7, translucency: 0.55,
             specular: 0.5, roughness: 0.35 },
    wind: { strength: 0.3, direction: 300, speed: 0.24, turbulence: 0.5,
            waveScale: 0.09, gustFreq: 0.2, gustStrength: 0.6, gustSpeed: 1.3 },
    plate: { pattern: 'noise', baseColor: '#b9c6d0', secColor: '#8e9daa',
             checkerScale: 3.5, grid: false, roughness: 0.55 },
    env: { timeOfDay: 9.2, exposure: 0.98, fogDensity: 0.016, fogAuto: false,
           fogColor: '#b9c7d4', shadows: true, shadowStrength: 0.35 },
    brush: { maxDensity: 110, scatter: 1, tilt: 0.25 }
  }
];

export function applyPreset(i) {
  var p = PRESETS[i];
  if (!p) return;
  if (p.grass) deepMerge(state.grass, p.grass);
  if (p.wind) deepMerge(state.wind, p.wind);
  if (p.plate) deepMerge(state.plate, p.plate);
  if (p.env) deepMerge(state.env, p.env);
  if (p.brush) deepMerge(state.brush, p.brush);
  rebuildBladeTemplate();
  syncGrassUniforms();
  syncGroundUniforms();
  syncEnvUniforms();
  Dens.dirty = true;
  emit('state');
  markSceneDirty();
  ui.toast('Preset: ' + p.name, 'ok');
}


