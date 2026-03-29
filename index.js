import 'dotenv/config';
import figlet from "figlet";
import PromptSync from "prompt-sync";
import EngDis from "./lib/engdis.lib.js";

const prompt = PromptSync({ sigint: true });

class Main {
  engdis = new EngDis();

  constructor() {
    this.welcome();
  }

  async main() {
    // --- CONFIGURACIÓN PARA LA USS ---
    // RECUERDA: Obtén un nuevo token si el bot dice "Error en el flujo principal"
    const miTokenUSS = process.env.USS_TOKEN; 
    const baseUrlUSS = "https://edwebservices.engdis.com/api/";

    console.log("[*] Conectando con la sesión del token...");
    this.engdis = new EngDis(baseUrlUSS, miTokenUSS);
    
    try {
      let courses = await this.selectCourse();
      if (courses.length > 0) {
        await this.setTaskSuccess(courses);
        const progress = await this.engdis.getProgress();
        console.log("\n========================================");
        console.log("[#] PROCESO COMPLETADO CON ÉXITO");
        console.log(`[#] Progreso final: ${progress[0]}% | Nota: ${progress[1]}`);
        console.log("========================================\n");
      }
    } catch (error) {
      console.log("\n[!] Error en el flujo principal. Verifica tu Token.");
    }
  }

  async welcome() {
    console.log(figlet.textSync("EngDis BOT"));
    console.log("[!] Last update: 28/03/2026\n");
  }

  async selectCourse() {
    const res = await this.engdis.getGetDefaultCourseProgress();
    if (!res.isSuccess) throw new Error("Token expirado");

    const all = (await prompt("[?] ¿Completar todos los cursos? (y/n): ")) === "y";
    return all ? res.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId })) : [];
  }

  async setTaskSuccess(courses) {
    for (const course of courses) {
      const tree = await this.engdis.getCourseTree(course.NodeId, course.ParentNodeId);
      if (!tree.isSuccess) continue;

      for (const unit of tree.data) {
        console.log(`\n[*] Unidad: ${unit.Name}`);
        
        for (const section of unit.Children) {
          if (section.Name !== "Test") {
            console.log(`  [>] Completando: ${section.Name}`);
            for (const task of section.Children) {
              await this.engdis.setSucessTask(course.ParentNodeId, task.NodeId);
            }
          } else {
            console.log(`  [!] Iniciando Oráculo de IA para el Test...`);
            // Enviamos el código, el ID de la sección y el ID del padre (Unit)
            await this.setTestAI(unit["Metadata"]["Code"], section.NodeId, unit.ParentNodeId);
          }
        }
      }
    }
  }

  async setTestAI(code, nodeId, parentNodeId) {
    try {
      // 1. "Calentamos" la tarea para avisar al servidor que entramos al test
      await this.engdis.setSucessTask(parentNodeId, nodeId); 
      await new Promise(r => setTimeout(r, 1000));

      // 2. Buscamos el JSON del Test usando el buscador dinámico del lib
      const res = await this.engdis.getTestItem(code, nodeId, parentNodeId);
      
      if (!res.isSuccess) {
        console.log("    [!] Error: El servidor no soltó el JSON. ¿Tienes el test abierto en Chrome?");
        return;
      }

      const item = res.data.i || res.data.item || res.data;
      const questions = item.q || item.questions || item.Questions;
      const submitAnswer = [];

      // 3. Procesamos cada pregunta con la IA
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
          // Fallback si la IA no responde
          submitAnswer.push({
            iId: item.id, iCode: item.c, iType: item.t || 1,
            ua: [{ qId: q.id, aId: [[q.al[0].id, options[0].id]] }]
          });
        }
        await new Promise(r => setTimeout(r, 1500)); // Delay humano
      }

      // 4. Enviamos los resultados
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