import { nanoid } from "nanoid";
import slugify from "slugify";

import * as schema from "../schema";
import { db } from "../database";

export async function createTag(tagName: string) {
  const values = {
    id: nanoid(),
    name: tagName,
    code: slugify(tagName).toLowerCase(),
  };

  const createdTags = await db.insert(schema.tags).values(values).returning();
  console.log("Tag created", createdTags[0]);
  return createdTags[0];
}
