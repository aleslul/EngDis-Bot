import figlet from "figlet";
import PromptSync from "prompt-sync";
import { config } from "./config/env.config.js";
import { UssClient } from "./api/uss.client.js";
import { AiService } from "./services/ai.service.js";
import { BotService } from "./services/bot.service.js";

const prompt = PromptSync({ sigint: true });

async function main() {
  console.log(figlet.textSync("EngDis BOT"));
  console.log("[!] Estructura Modular y Desacoplada\n");

  if (!config.ussToken) {
    console.log("[!] Error crítico: USS_TOKEN no encontrado en el archivo .env");
    return;
  }

  console.log("[*] Conectando con la sesión del token...");
  const ussClient = new UssClient(config.baseUrl, config.ussToken);
  const aiService = new AiService();
  const botService = new BotService(ussClient, aiService);

  try {
    console.log("--- SELECCIÓN DE CURSO ---");
    console.log("[1] General English: Basic 3 (ID: 44205)");
    console.log("[2] General English: Intermediate 1 (ID: 44845)");
    console.log("[3] TOEIC Official Learning 2 (ID: 1547470)");
    console.log("[4] TOEIC Official Learning 3 (ID: 1548014)");
    
    const op = await prompt("[?] Opción: ");
    let targetCourseId = null;
    let isToeic = false;

    if (op === "1") targetCourseId = 44205;
    else if (op === "2") targetCourseId = 44845;
    else if (op === "3") { isToeic = true; targetCourseId = 1547470; }
    else if (op === "4") { isToeic = true; targetCourseId = 1548014; }
    else return console.log("[!] Opción no válida.");

    const res = await ussClient.getSpecificCourseProgress(targetCourseId);
    if (!res.isSuccess) throw new Error(`Error obteniendo datos del curso ${targetCourseId}. Token expirado.`);

    const all = (await prompt("[?] ¿Completar todo el curso seleccionado? (y/n): ")) === "y";
    const coursesToProcess = all ? res.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name })) : [];

    if (coursesToProcess.length > 0) {
      await botService.processCourses(coursesToProcess, isToeic);
      const progress = isToeic ? ["(Revisa tu portal TOEIC)", "N/A"] : await ussClient.getProgress();
      
      console.log("\n========================================");
      console.log("[#] PROCESO COMPLETADO CON ÉXITO");
      console.log(`[#] Progreso final: ${progress[0]}%`);
      console.log("========================================\n");
    }
  } catch (error) {
    console.log("\n[!] Error en el flujo principal:", error.message);
  }
}

main();