import 'dotenv/config';
import figlet from "figlet";
import PromptSync from "prompt-sync";
import EngDis from "./lib/engdis.lib.js";

const prompt = PromptSync({ sigint: true });

class Main {
  engdis = new EngDis();
  isToeic = false; // Bandera de estado para saber en qué modo estamos

  constructor() {
    this.welcome();
  }

  async main() {
    const miTokenUSS = process.env.USS_TOKEN; 
    const baseUrlUSS = "https://edwebservices.engdis.com/api/";

    if (!miTokenUSS) {
      console.log("[!] Error crítico: USS_TOKEN no encontrado en el archivo .env");
      return;
    }

    console.log("[*] Conectando con la sesión del token...");
    this.engdis = new EngDis(baseUrlUSS, miTokenUSS);
    
    try {
      let courses = await this.selectCourse();
      if (courses.length > 0) {
        await this.setTaskSuccess(courses);
        
        // El progreso final lo sacamos según el modo
        const progress = this.isToeic ? ["(Calculado en portal)", "N/A"] : await this.engdis.getProgress();
        
        console.log("\n========================================");
        console.log("[#] PROCESO COMPLETADO CON ÉXITO");
        console.log(`[#] Progreso final: ${progress[0]}%`);
        console.log("========================================\n");
      }
    } catch (error) {
      console.log("\n[!] Error en el flujo principal. Verifica tu Token.");
      // console.log(error); // Descomenta para debugguear si falla
    }
  }

  async welcome() {
    console.log(figlet.textSync("EngDis BOT"));
    console.log("[!] Last update: 28/03/2026 - Multicurso\n");
  }

  async selectCourse() {
    console.log("--- SELECCIÓN DE CURSO ---");
    console.log("[1] Basic 3 (General English)");
    console.log("[2] TOEIC Official Learning 2");
    
    const op = await prompt("[?] Opción: ");

    if (op === "2") {
      this.isToeic = true;
      const res = await this.engdis.getSpecificCourseProgress(1547470);
      if (!res.isSuccess) throw new Error("Error obteniendo datos del TOEIC");

      const all = (await prompt("[?] ¿Completar lecciones del TOEIC (Sin Tests)? (y/n): ")) === "y";
      return all ? res.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name })) : [];
    } else {
      this.isToeic = false;
      const res = await this.engdis.getGetDefaultCourseProgress();
      if (!res.isSuccess) throw new Error("Token expirado");

      const all = (await prompt("[?] ¿Completar todo el Basic 3 (Con Tests)? (y/n): ")) === "y";
      return all ? res.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name })) : [];
    }
  }

  async setTaskSuccess(courses) {
    for (const course of courses) {
      console.log(`\n========================================`);
      console.log(`🚀 PROCESANDO UNIDAD: ${course.Name || course.NodeId}`);
      console.log(`========================================`);

      const tree = await this.engdis.getCourseTree(course.NodeId, course.ParentNodeId);
      if (!tree.isSuccess) continue;

      for (const unit of tree.data) {
        console.log(`\n[*] Lección: ${unit.Name}`);
        
        for (const section of unit.Children) {
          if (section.Name !== "Test") {
            console.log(`  [>] Completando: ${section.Name}`);
            for (const task of section.Children) {
              await this.engdis.setSucessTask(course.ParentNodeId, task.NodeId);
            }
          } else {
            // Lógica condicional según el curso
            if (this.isToeic) {
              console.log(`  [!] Saltando Test de TOEIC por ahora...`);
            } else {
              console.log(`  [!] Iniciando Oráculo de IA para el Test...`);
              await this.setTestAI(unit["Metadata"]["Code"], section.NodeId, unit.ParentNodeId);
            }
          }
        }
      }
    }
  }

  async setTestAI(code, nodeId, parentNodeId) {
    try {
      await this.engdis.setSucessTask(parentNodeId, nodeId); 
      await new Promise(r => setTimeout(r, 1000));

      const res = await this.engdis.getTestItem(code, nodeId, parentNodeId);
      
      if (!res.isSuccess) {
        console.log("    [!] Error: El servidor no soltó el JSON. ¿Tienes el test abierto en Chrome?");
        return;
      }

      const item = res.data.i || res.data.item || res.data;
      const questions = item.q || item.questions || item.Questions;
      const submitAnswer = [];

      for (const q of questions) {
        const preguntaTexto = (q.t || q.d || "Audio/Video task").replace(/<[^>]*>?/gm, '').trim();
        
        const options = q.al[0].a.map(opt => ({
          id: opt.id,
          text: opt.t.replace(/<[^>]*>?/gm, '').trim()
        }));

        const idCorrecto = await this.engdis.consultarIA(preguntaTexto, options);
        
        if (idCorrecto) {
          submitAnswer.push({
            iId: item.id,
            iCode: item.c,
            iType: item.t || 1,
            ua: [{ qId: q.id, aId: [[q.al[0].id, idCorrecto.trim()]] }]
          });
          console.log(`    [#] IA respondió ID: ${idCorrecto}`);
        } else {
          submitAnswer.push({
            iId: item.id, iCode: item.c, iType: item.t || 1,
            ua: [{ qId: q.id, aId: [[q.al[0].id, options[0].id]] }]
          });
        }
        await new Promise(r => setTimeout(r, 1500));
      }

      const status = await this.engdis.SaveUserTestV1(nodeId, parentNodeId, submitAnswer);
      console.log(`    [#] Resultado: ${status.data?.finalMark ? status.data.finalMark + "%" : "Enviado correctamente"}`);
      
    } catch (e) {
      console.log("    [!] Error crítico procesando el Test.");
    }
  }
}

(async () => {
  const main = new Main();
  main.main();
})();