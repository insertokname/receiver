// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Web build: upstream BrandedQRCode.dom.tsx with receiver's logo in the centre.
import { useMemo, type JSX } from 'react';
import QR from 'qrcode-generator';

export type PropsType = Readonly<{
  size: number;
  link: string;
  color: string;
}>;

// receiver's chat-bubble logo (web/renderer/brand/logo.svg) on the same 36x36
// grid as upstream's logo: an outlined bubble and three dots. An outline keeps
// the centre as light as upstream's logo, which scanners need.
const BUBBLE_PATH =
  'M12 5H24A9 9 0 0 1 33 14V18A9 9 0 0 1 24 27H14L6 32L5.64 24.36A9 9 0 0 1 ' +
  '3 18V14A9 9 0 0 1 12 5Z';
const BUBBLE_STROKE_WIDTH = 2.6;
const DOT_CENTERS_X = [11, 18, 25];
const DOT_CENTER_Y = 16;
const DOT_RADIUS = 2;

const AUTODETECT_TYPE_NUMBER = 0;
const ERROR_CORRECTION_LEVEL = 'H';
const CENTER_CUTAWAY_PERCENTAGE = 30 / 184;
const CENTER_LOGO_PERCENTAGE = 38 / 184;
const QR_NATIVE_SIZE = 36;

type ComputeResultType = Readonly<{
  path: string;
  moduleCount: number;
  radius: number;
}>;

function compute(link: string): ComputeResultType {
  const qr = QR(AUTODETECT_TYPE_NUMBER, ERROR_CORRECTION_LEVEL);
  qr.addData(link);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const center = moduleCount / 2;
  const radius = CENTER_CUTAWAY_PERCENTAGE * moduleCount;

  function hasPixel(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= moduleCount || y >= moduleCount) {
      return false;
    }

    const distanceFromCenter = Math.sqrt(
      (x - center + 0.5) ** 2 + (y - center + 0.5) ** 2
    );

    // Center and 1 dot away should remain clear for the logo placement.
    if (Math.ceil(distanceFromCenter) <= radius + 3) {
      return false;
    }

    return qr.isDark(x, y);
  }

  const path = [];
  for (let y = 0; y < moduleCount; y += 1) {
    for (let x = 0; x < moduleCount; x += 1) {
      if (!hasPixel(x, y)) {
        continue;
      }

      const onTop = hasPixel(x, y - 1);
      const onBottom = hasPixel(x, y + 1);
      const onLeft = hasPixel(x - 1, y);
      const onRight = hasPixel(x + 1, y);

      const roundTL = !onLeft && !onTop;
      const roundTR = !onTop && !onRight;
      const roundBR = !onRight && !onBottom;
      const roundBL = !onBottom && !onLeft;

      path.push(
        `M${2 * x} ${2 * y + 1}`,
        roundTL ? 'a1 1 0 0 1 1 -1' : 'v-1h1',
        roundTR ? 'a1 1 0 0 1 1 1' : 'h1v1',
        roundBR ? 'a1 1 0 0 1 -1 1' : 'v1h-1',
        roundBL ? 'a1 1 0 0 1 -1 -1' : 'h-1v-1',
        'z'
      );
    }
  }

  return {
    path: path.join(''),
    moduleCount,
    radius,
  };
}

export function BrandedQRCode({ size, link, color }: PropsType): JSX.Element {
  const { path, moduleCount, radius } = useMemo(() => compute(link), [link]);

  const QR_SCALE = size / 2 / moduleCount;

  const CENTER_X = size / 2;
  const CENTER_Y = size / 2;
  const LOGO_SIZE = CENTER_LOGO_PERCENTAGE * size;
  const LOGO_X = CENTER_X - LOGO_SIZE / 2;
  const LOGO_Y = CENTER_Y - LOGO_SIZE / 2;
  const LOGO_SCALE = LOGO_SIZE / QR_NATIVE_SIZE;

  return (
    <>
      <g transform={`scale(${QR_SCALE} ${QR_SCALE})`}>
        <path d={path} fill={color} />

        <circle
          cx={moduleCount}
          cy={moduleCount}
          r={radius * 2}
          stroke={color}
          strokeWidth={2}
        />
      </g>

      <g
        transform={`translate(${LOGO_X} ${LOGO_Y}) scale(${LOGO_SCALE} ${LOGO_SCALE})`}
      >
        <path
          d={BUBBLE_PATH}
          fill="none"
          stroke={color}
          strokeWidth={BUBBLE_STROKE_WIDTH}
          strokeLinejoin="round"
        />
        {DOT_CENTERS_X.map(cx => (
          <circle
            key={cx}
            cx={cx}
            cy={DOT_CENTER_Y}
            r={DOT_RADIUS}
            fill={color}
          />
        ))}
      </g>
    </>
  );
}
