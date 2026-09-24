import { schema } from "../amplify/data/resource.js";

const sdl = schema.transform().schema;
console.log(sdl);
