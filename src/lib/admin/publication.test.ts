import { expect, test } from "vitest";
import { validateManifest, validateSnapshot } from "./publication.ts";

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 3,
  state: "published",
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
};
const override = {
  event_id: "event-20261112-12345678",
  image: { upload: null, crop: { x: 50, y: 50, zoom: 1 } },
  schedule: null,
  updated_at: "2026-11-12T00:00:00Z",
};

test("a null public marker cannot carry unpublished overrides", () => {
  expect(validateManifest({ publication: null, overrides: [] })).toEqual({
    publication: null,
    overrides: [],
  });
  expect(() =>
    validateManifest({ publication: null, overrides: [override] }),
  ).toThrow();
});

test("snapshot rejects duplicate event edits, empty edits and invalid crop coordinates", () => {
  for (const overrides of [
    [override, override],
    [{ ...override, image: null }],
    [
      {
        ...override,
        image: { upload: null, crop: { x: 101, y: 50, zoom: 1 } },
      },
    ],
  ])
    expect(() => validateSnapshot({ publication, overrides })).toThrow();
});

test("manifest validates immutable schedule shape independent of current official metadata", () => {
  const value = {
    publication: { id: publication.id, revision: 3 },
    overrides: [
      {
        ...override,
        schedule: {
          start: "2026-11-12",
          end: "2026-11-14",
          start_after_maintenance: false,
        },
      },
    ],
  };
  expect(validateManifest(value)).toEqual(value);
  expect(() =>
    validateManifest({
      ...value,
      publication: { ...value.publication, revision: -1 },
    }),
  ).toThrow();
});
