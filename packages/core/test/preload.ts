import path from "path"

process.env.CYBERVINCI_DB = ":memory:"
process.env.CYBERVINCI_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.CYBERVINCI_DISABLE_MODELS_FETCH = "true"
