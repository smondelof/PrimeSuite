import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavGroup } from './navGroups';

// ---------- Iconos (trazo, heredan currentColor) ----------
const P = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
export const Icon = {
  home: () => <svg {...P}><path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" /></svg>,
  grid: () => <svg {...P}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  plug: () => <svg {...P}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" /></svg>,
  shield: () => <svg {...P}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>,
  users: () => <svg {...P}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><circle cx="17" cy="9" r="2.5" /><path d="M17 14.5c2.3 0 4 1.5 4.5 4" /></svg>,
  layers: () => <svg {...P}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></svg>,
  building: () => <svg {...P}><path d="M4 21V5l8-3v19M12 8h8v13M8 9h.01M8 13h.01M8 17h.01M16 12h.01M16 16h.01" /></svg>,
  tag: () => <svg {...P}><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1" /></svg>,
  list: () => <svg {...P}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  plus: () => <svg {...P} strokeWidth={2.2}><path d="M12 5v14M5 12h14" /></svg>,
  search: () => <svg {...P} width={16} height={16}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  x: () => <svg {...P}><path d="M6 6l12 12M18 6 6 18" /></svg>,
  menu: () => <svg {...P}><path d="M3 6h18M3 12h18M3 18h18" /></svg>,
  panel: () => <svg {...P}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>,
  ext: () => <svg {...P} width={16} height={16}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
  refresh: () => <svg {...P} width={16} height={16}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>,
  back: () => <svg {...P} width={16} height={16}><path d="M15 6l-6 6 6 6" /></svg>,
  copy: () => <svg {...P} width={15} height={15}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>,
  trash: () => <svg {...P} width={16} height={16}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  edit: () => <svg {...P} width={16} height={16}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>,
  logout: () => <svg {...P} width={16} height={16}><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></svg>,
  up: () => <svg {...P} width={14} height={14}><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  down: () => <svg {...P} width={14} height={14}><path d="M12 5v14M6 13l6 6 6-6" /></svg>,
  ok: () => <svg {...P} width={20} height={20} stroke="#15803D" strokeWidth={2.2}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>,
  warn: () => <svg {...P} width={20} height={20} stroke="#B45309" strokeWidth={2.2}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></svg>,
  info: () => <svg {...P} width={20} height={20} stroke="#5E5B66" strokeWidth={2.2}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>,
  user: () => <svg {...P}><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>,
  eye: () => <svg {...P} width={18} height={18}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  eyeOff: () => <svg {...P} width={18} height={18}><path d="M2 12s3.5-7 10-7c1.6 0 3 .4 4.3 1M22 12s-3.5 7-10 7c-1.6 0-3-.4-4.3-1" /><path d="M4 4l16 16" /></svg>,
  chart: () => <svg {...P}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  trend: () => <svg {...P}><path d="m3 17 6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>,
  apps: () => <svg {...P}><circle cx="6" cy="6" r="2" /><circle cx="12" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="12" cy="18" r="2" /><circle cx="18" cy="18" r="2" /></svg>,
  calendar: () => <svg {...P}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /></svg>,
  briefcase: () => <svg {...P}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></svg>,
  sliders: () => <svg {...P}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>,
  file: () => <svg {...P}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>,
  widgets: () => <svg {...P}><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="5" rx="2" /><rect x="13" y="10" width="8" height="11" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /></svg>,
  key: () => <svg {...P}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14 9l2 2" /></svg>,
  laptop: () => <svg {...P}><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 20h20" /></svg>,
  chevron: () => <svg {...P} width={16} height={16}><path d="m6 9 6 6 6-6" /></svg>,
  settings: () => <svg {...P}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 .3-1.8l-.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
};

// Logotipo corporativo de PRIMION (wordmark). Usa currentColor para adaptarse
// al fondo: blanco en la barra lateral azul marino, azul marino sobre fondo claro.
export function Logo({ height = 26 }: { height?: number }) {
  return (
    <svg height={height} viewBox="0 0 148 40" fill="currentColor" role="img" aria-label="primion" style={{ display: 'block', width: 'auto' }}>
      <path d="M75.8163 12.4905C71.4069 12.4905 68.0962 15.7109 68.0962 19.9848C68.0962 24.2587 71.4069 27.5394 75.8163 27.5394C80.2256 27.5394 83.5665 24.2888 83.5665 19.9848C83.5665 15.6808 80.2407 12.4905 75.8163 12.4905ZM75.8163 24.7553C73.2429 24.7553 71.3167 22.7087 71.3167 19.9999C71.3167 17.2911 73.258 15.2896 75.8163 15.2896C78.3746 15.2896 80.3611 17.3061 80.3611 19.9999C80.3611 22.6936 78.4047 24.7553 75.8163 24.7553Z" />
      <path d="M31.5124 14.8381V27.2384H30.3837C29.0143 27.2384 28.3672 26.6064 28.3672 25.2369V12.8216H29.4959C30.8653 12.8216 31.5124 13.4687 31.5124 14.8381Z" />
      <path d="M31.8429 8.93896C31.8429 9.99238 30.9851 10.8502 29.9317 10.8502C28.8783 10.8502 28.0205 9.99238 28.0205 8.93896C28.0205 7.88553 28.8783 7.0127 29.9317 7.0127C30.9851 7.0127 31.8429 7.87048 31.8429 8.93896Z" />
      <path d="M64.7859 14.8381V27.2384H63.6573C62.2878 27.2384 61.6558 26.6064 61.6558 25.2369V12.8216H62.7844C64.1539 12.8216 64.7859 13.4687 64.7859 14.8381Z" />
      <path d="M65.1168 8.93896C65.1168 9.99238 64.259 10.8502 63.2056 10.8502C62.1521 10.8502 61.2793 9.99238 61.2793 8.93896C61.2793 7.88553 62.1371 7.0127 63.2056 7.0127C64.274 7.0127 65.1168 7.87048 65.1168 8.93896Z" />
      <path d="M57.4571 18.0737V27.2384H56.2983C54.9288 27.2384 54.2968 26.6064 54.2968 25.2369V18.7509C54.2968 17.0804 52.9424 15.711 51.2569 15.711C49.5714 15.711 48.217 17.0654 48.217 18.7509V27.2384H47.0432C45.6738 27.2384 45.0267 26.6064 45.0267 25.2369V18.7509C45.0267 17.0804 43.6572 15.711 41.9868 15.711C40.3163 15.711 38.9469 17.0654 38.9469 18.7509V27.2384H35.7866V12.8216H36.8099C37.9537 12.8216 38.6008 13.258 38.7362 14.1008C39.5187 13.3032 40.7227 12.5808 42.1824 12.5808C43.6422 12.5808 45.5684 13.5289 46.6218 15.41C47.6602 13.6493 49.5413 12.5808 51.6181 12.5808C54.7031 12.5808 57.2464 15.0037 57.427 18.0586H57.442L57.4571 18.0737Z" />
      <path d="M25.4027 16.027C24.3643 15.7863 21.8361 16.1775 21.7609 18.7358V27.2234H18.6006V12.8066H19.6691C20.3613 12.8066 20.8429 12.9721 21.1589 13.3182C21.3545 13.5139 21.4749 13.7848 21.5201 14.1008C22.9046 12.5658 25.3876 12.8066 25.3876 12.8066V16.012L25.4027 16.027Z" />
      <path d="M98.9014 27.2385H97.7426C96.3732 27.2385 95.7411 26.5914 95.7411 25.2219V18.7509C95.7411 17.0805 94.3867 15.711 92.7012 15.711C91.0157 15.711 89.6613 17.0654 89.6613 18.7509V27.2385H86.5161V12.8216H87.5846C88.2768 12.8216 88.7584 12.9872 89.0744 13.3333C89.2701 13.5289 89.3905 13.7998 89.4356 14.1158C90.3987 13.1226 91.6327 12.5959 93.0473 12.5959C96.2528 12.5959 98.8562 15.2144 98.8562 18.4048V27.2385H98.9014Z" />
      <path d="M7.96087 12.4905C6.09481 12.4905 4.33408 13.0924 2.94959 14.2061C2.85929 13.2881 2.19714 12.8216 1.00828 12.8216H0V32.7162H3.16027V26.2903C3.16027 26.185 3.16027 26.0796 3.16027 25.9743C4.49962 26.9976 6.1851 27.5544 7.96087 27.5544C12.3853 27.5544 15.696 24.3039 15.696 19.9999C15.696 15.6959 12.3702 12.5055 7.96087 12.5055V12.4905ZM7.96087 24.7553C5.38751 24.7553 3.4462 22.7087 3.4462 19.9999C3.4462 17.2911 5.38751 15.2896 7.96087 15.2896C10.5342 15.2896 12.4906 17.3061 12.4906 19.9999C12.4906 22.6936 10.5493 24.7553 7.96087 24.7553Z" />
      <path d="M147.584 20.0151L127.6 40L123.07 35.4703C123.07 35.4703 123.085 35.4552 123.1 35.4402L136.809 21.7306C137.773 20.7675 137.773 19.2175 136.809 18.2694L123.1 4.55982C123.1 4.55982 123.085 4.54477 123.07 4.52972L127.6 0L147.584 19.985V20.0151Z" />
      <path d="M118.209 27.5394C122.365 27.5394 125.733 24.1706 125.733 20.015C125.733 15.8594 122.365 12.4905 118.209 12.4905C114.053 12.4905 110.685 15.8594 110.685 20.015C110.685 24.1706 114.053 27.5394 118.209 27.5394Z" />
    </svg>
  );
}

// Símbolo aislado (flecha + punto) para el favicon y espacios reducidos.
export function LogoMark({ size = 26, color = '#FF3E41' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="106 0 42 40" fill={color} role="img" aria-label="primion" style={{ display: 'block' }}>
      <path d="M147.584 20.0151L127.6 40L123.07 35.4703C123.07 35.4703 123.085 35.4552 123.1 35.4402L136.809 21.7306C137.773 20.7675 137.773 19.2175 136.809 18.2694L123.1 4.55982C123.1 4.55982 123.085 4.54477 123.07 4.52972L127.6 0L147.584 19.985V20.0151Z" />
      <path d="M118.209 27.5394C122.365 27.5394 125.733 24.1706 125.733 20.015C125.733 15.8594 122.365 12.4905 118.209 12.4905C114.053 12.4905 110.685 15.8594 110.685 20.015C110.685 24.1706 114.053 27.5394 118.209 27.5394Z" />
    </svg>
  );
}

function soft(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * 0.87);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Aclara (+) u oscurece (-) un color hex. amt en -1..1.
function shade(hex: string, amt: number) {
  const n = parseInt((hex || '#243A4D').slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (c: number) => (amt >= 0 ? Math.round(c + (255 - c) * amt) : Math.round(c * (1 + amt)));
  return `#${[f(r), f(g), f(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// Degradado de marca para los iconos de glifo/iniciales a partir de un color base.
export const iconGradient = (hex: string) => `linear-gradient(135deg, ${shade(hex || '#243A4D', 0.14)}, ${shade(hex || '#243A4D', -0.14)})`;

// Galería de iconos integrados: clave → interior del SVG (trazo blanco, viewBox 0 0 24 24).
export const APP_GLYPHS: Record<string, string> = {
  bars: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 4-7 8-7s7 2 8 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  spark: '<path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18"/>',
  pie: '<path d="M12 3v9h9a9 9 0 1 1-9-9z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  building: '<path d="M4 21V5l8-3v19M12 8h8v13M8 9h.01M8 13h.01M16 12h.01M16 16h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2M17 6l2 2"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 7l2-3h4l2 3"/>',
  car: '<path d="M3 13l2-5h14l2 5v5h-3M3 18v-5m0 5h3m12 0H6"/><circle cx="7.5" cy="18" r="1.5"/><circle cx="16.5" cy="18" r="1.5"/>',
  cloud: '<path d="M6 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 18 18z"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 7 2 8 2 8H4s2-1 2-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  chat: '<path d="M4 5h16v11H8l-4 4z"/>',
  map: '<path d="m9 4 6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/>',
  wrench: '<path d="M14 7a4 4 0 0 1-5 5l-6 6 2 2 6-6a4 4 0 0 0 5-5z"/>',
  badge: '<circle cx="12" cy="9" r="5"/><path d="m8 13-2 8 6-3 6 3-2-8"/>',
  fingerprint: '<path d="M12 11a2 2 0 0 1 2 2c0 3-1 5-1 5M8 12a4 4 0 0 1 8 0c0 4-1 6-1 6M5 13a7 7 0 0 1 14 0c0 2 0 3-.5 5"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 3-4 3 3 5-7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'
};
export const APP_GLYPH_KEYS = Object.keys(APP_GLYPHS);

export function AppIcon({ initials, color, size = 44, iconUrl, glyph, shadow }: { initials: string; color: string; size?: number; iconUrl?: string; glyph?: string; shadow?: boolean }) {
  const radius = Math.round(size / 4.2);
  // 1) Imagen subida
  if (iconUrl) {
    return (
      <span
        className={`app-icon img${shadow ? ' sh' : ''}`}
        style={{ width: size, height: size, borderRadius: radius, backgroundImage: `url("${iconUrl.replace(/"/g, '%22')}")` }}
        role="img"
        aria-label={initials}
      />
    );
  }
  // 2) Icono integrado (glifo) con degradado de marca
  if (glyph && APP_GLYPHS[glyph]) {
    const s = Math.round(size * 0.5);
    return (
      <span className={`app-icon glyph${shadow ? ' sh' : ''}`} style={{ width: size, height: size, borderRadius: radius, background: iconGradient(color || '#243A4D') }} role="img" aria-label={initials}>
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: APP_GLYPHS[glyph] }} />
      </span>
    );
  }
  // 3) Iniciales sobre fondo suave
  return (
    <span className={`app-icon${shadow ? ' sh' : ''}`} style={{ width: size, height: size, borderRadius: radius, background: soft(color || '#52525B'), color: color || '#52525B', fontSize: Math.max(11, Math.round(size / 3)) }}>
      {initials}
    </span>
  );
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Cargando" />;
}

export function Loading() {
  return (
    <div className="row" style={{ padding: 40, justifyContent: 'center' }}>
      <Spinner />
    </div>
  );
}

export function Modal({ title, onClose, children, wide, width }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // En un portal: las superficies de cristal (backdrop-filter) recortarían un overlay fijo anidado en ellas.
  return createPortal(
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : wide ? { width: 'min(760px, 100%)' } : undefined}>
        <div className="row">
          <h2 className="grow">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar"><Icon.x /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function Drawer({ title, onClose, children, width }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="row">
          <div className="grow">{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar"><Icon.x /></button>
        </div>
        {children}
      </aside>
    </div>,
    document.body
  );
}

// ---------- Toasts ----------
interface Toast { id: number; msg: string; error?: boolean }
const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((msg: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, msg, error }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Datos ----------
export function useData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    loader()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message || 'Error'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

export function CopyValue({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="v">
      <span>{value}</span>
      <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Copiar" onClick={() => navigator.clipboard.writeText(value).then(() => toast('Copiado'))}>
        <Icon.copy />
      </button>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert error">{error}</div> : null;
}

export function confirmAction(msg: string) {
  return window.confirm(msg);
}

// ---------- Bloque plegable (pantallas de configuración) ----------
/**
 * Bloque de configuración que se puede plegar. Plegado muestra solo el título y un resumen de lo configurado;
 * desplegado, la descripción, las acciones y el contenido. Recuerda (por navegador) si se dejó abierto.
 */
export function Fold({ id, title, icon, subtitle, summary, action, defaultOpen = false, nested, children }: {
  id: string; title: ReactNode; icon?: ReactNode; subtitle?: ReactNode; summary?: ReactNode; action?: ReactNode;
  defaultOpen?: boolean; nested?: boolean; children: ReactNode;
}) {
  const [open, toggle] = useNavGroup(`fold:${id}`, false, defaultOpen);
  return (
    <section className={`fold${nested ? ' nested' : ' card'}${open ? ' open' : ''}`}>
      <div className="fold-head">
        <button type="button" className="fold-btn" aria-expanded={open} onClick={toggle}>
          {icon && <span className="fold-ico">{icon}</span>}
          <span className="fold-txt">
            <span className="fold-title">{title}</span>
            {open ? (subtitle ? <span className="xs muted">{subtitle}</span> : null) : summary ? <span className="fold-sum">{summary}</span> : null}
          </span>
          <span className={`chev${open ? ' open' : ''}`}><Icon.chevron /></span>
        </button>
        {action && open && <div className="fold-action">{action}</div>}
      </div>
      <div className={`nav-sub${open ? ' open' : ''}`}><div className="fold-body">{children}</div></div>
    </section>
  );
}
