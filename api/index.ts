import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import * as XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = process.env.VERCEL ? path.join("/tmp", "data.json") : path.join(__dirname, "data.json");

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Load initial data
  let currentData: any[] = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      currentData = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    } catch (e) {
      console.error("Error loading data.json", e);
    }
  }

  const storage = multer.memoryStorage();
  const upload = multer({ storage: storage });

  // API Routes
  app.post("/api/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      currentData = jsonData;
      fs.writeFileSync(DATA_FILE, JSON.stringify(currentData, null, 2));

      res.json({ message: "File uploaded and processed successfully", count: currentData.length });
    } catch (error) {
      console.error("Error processing Excel file:", error);
      res.status(500).json({ error: "Failed to process Excel file" });
    }
  });

  app.post("/api/sync-sheets", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    try {
      // Transform standard Google Sheets URL to CSV export URL
      let exportUrl = url;
      if (url.includes("docs.google.com/spreadsheets")) {
        if (url.includes("/pub?")) {
          // Already a published link, ensure it's CSV
          if (!url.includes("output=csv")) {
            exportUrl = url.includes("?") ? `${url}&output=csv` : `${url}?output=csv`;
          }
        } else {
          // Standard edit link
          const match = url.match(/\/d\/(.+?)(\/|$)/);
          if (match && match[1]) {
            exportUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
          }
        }
      }

      const response = await fetch(exportUrl);
      if (!response.ok) throw new Error("Failed to fetch Google Sheet");

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      // Read workbook - SheetJS handles CSV automatically
      const workbook = XLSX.read(buffer, { type: "buffer", codepage: 65001 });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

      currentData = jsonData;
      fs.writeFileSync(DATA_FILE, JSON.stringify(currentData, null, 2));

      res.json({ message: "Sincronizado com sucesso!", count: currentData.length });
    } catch (error) {
      console.error("Error syncing Google Sheets:", error);
      res.status(500).json({ error: "Falha ao sincronizar com Google Sheets. Verifique se o link é público." });
    }
  });

  app.get("/api/data", (req, res) => {
    const { search, field, restrictVendor } = req.query;
    
    let filtered = currentData;

    // Apply vendor restriction if provided (for security/access control)
    if (restrictVendor) {
      const vendorStr = String(restrictVendor).toLowerCase();
      filtered = filtered.filter(item => 
        String(item.VENDEDOR || "").toLowerCase() === vendorStr
      );
    }

    if (search) {
      const searchStr = String(search).toLowerCase();
      filtered = filtered.filter((item: any) => {
        if (field && item[field as string]) {
          const itemValue = String(item[field as string]).toLowerCase();
          // Exact match for Vendedor, partial for others
          if (field === "VENDEDOR") {
            return itemValue === searchStr;
          }
          return itemValue.includes(searchStr);
        }
        // Global search if no field specified
        return Object.values(item).some(val => 
          String(val).toLowerCase().includes(searchStr)
        );
      });
    }

    res.json(filtered.slice(0, 500)); // Limit results
  });

  app.get("/api/stats", (req, res) => {
    res.json({
      totalRecords: currentData.length,
      lastUpdated: fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtime : null
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

const appPromise = startServer();
export default async (req: any, res: any) => {
  const app = await appPromise;
  return app(req, res);
};
