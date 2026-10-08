import { uuid } from "./fragments.js";

export const getMediaThumbnailSchema = {
  params: {
    type: "object",
    properties: { media_id: uuid },
    required: ["media_id"],
    additionalProperties: false,
  },
} as const;

export const getMediaAssetSchema = {
  params: {
    type: "object",
    properties: { media_id: uuid },
    required: ["media_id"],
    additionalProperties: false,
  },
} as const;
