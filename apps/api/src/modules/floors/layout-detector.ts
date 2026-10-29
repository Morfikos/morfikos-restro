import { FLOOR_OBJECT_TYPES, TABLE_SHAPES } from "@morfikos/validation";

/**
 * Turns a restaurant photo or sketch into a draft floor layout using the
 * Google Gemini API (free tier) over plain REST, so no SDK is needed.
 *
 * Configure with GEMINI_API_KEY (from Google AI Studio) and optionally
 * GEMINI_MODEL. The default model alias always points at Google's current
 * Flash model, so it keeps working as model versions change.
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

/** How long to wait for Gemini before giving up. */
const GEMINI_TIMEOUT_MS = 90_000;

/** The image and canvas the layout is detected for. */
export interface LayoutDetectionInput {
  image: Buffer;
  mimeType: string;
  floorWidth: number;
  floorHeight: number;
}

/**
 * Checks whether a layout detector is configured.
 *
 * @returns True when GEMINI_API_KEY is set.
 */
export function isLayoutDetectorConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * JSON schema Gemini must answer with (Gemini's OpenAPI subset).
 */
const LAYOUT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    tables: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          seats: { type: "INTEGER" },
          shape: { type: "STRING", enum: [...TABLE_SHAPES] },
          positionX: { type: "NUMBER" },
          positionY: { type: "NUMBER" },
          width: { type: "NUMBER" },
          height: { type: "NUMBER" },
          rotation: { type: "NUMBER" },
        },
        required: ["name", "seats", "shape", "positionX", "positionY", "width", "height"],
      },
    },
    objects: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: [...FLOOR_OBJECT_TYPES] },
          label: { type: "STRING" },
          positionX: { type: "NUMBER" },
          positionY: { type: "NUMBER" },
          width: { type: "NUMBER" },
          height: { type: "NUMBER" },
          rotation: { type: "NUMBER" },
        },
        required: ["type", "positionX", "positionY", "width", "height"],
      },
    },
  },
  required: ["tables", "objects"],
} as const;

/**
 * Builds the instructions sent with the image.
 *
 * @param floorWidth - Canvas width in map units.
 * @param floorHeight - Canvas height in map units.
 * @returns The prompt text.
 */
function buildPrompt(floorWidth: number, floorHeight: number): string {
  return [
    "You are converting a picture of a restaurant dining area into a top-down floor map.",
    "The picture may be a normal photo taken at an angle, a top-down photo, or a hand-drawn sketch.",
    "If it is an angled photo, correct for perspective and estimate where each item would sit when viewed from directly above.",
    "",
    `Use a canvas ${floorWidth} units wide and ${floorHeight} units tall, origin at the top-left corner.`,
    "positionX/positionY are the top-left corner of each item's bounding box; width/height are its size; rotation is in degrees.",
    "Keep every item fully inside the canvas and keep relative distances between items realistic.",
    "",
    "List every dining table in `tables`:",
    "- name: the table number or label written on or near it if visible, otherwise T1, T2, ... in reading order. Names must be unique.",
    "- seats: count the chairs around it; if unclear, estimate from its size (small 2, medium 4, large 6+).",
    "- shape: ROUND, SQUARE or RECTANGLE.",
    "",
    "List fixed non-table features in `objects` (walls, bar counter, entrance, kitchen, washroom, pillars, stairs, windows).",
    "Use type OTHER with a short label for anything else worth showing. Do not list chairs as objects.",
    "If the picture does not show a dining area, return empty tables and objects arrays.",
  ].join("\n");
}

/**
 * Asks Gemini to detect tables and fixed objects in the image.
 *
 * The returned JSON is not trusted: the caller validates and normalizes it.
 *
 * @param input - The image and the floor canvas size.
 * @returns The raw layout JSON produced by the model.
 * @throws Error If the API key is missing, the request fails or the reply is not JSON.
 */
export async function detectFloorLayout(input: LayoutDetectionInput): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const response = await fetch(
    `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: buildPrompt(input.floorWidth, input.floorHeight) },
              {
                inlineData: {
                  mimeType: input.mimeType,
                  data: input.image.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: LAYOUT_RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(`Gemini request failed with status ${response.status}: ${details}`);
  }

  const body = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = body.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return JSON.parse(text);
}
