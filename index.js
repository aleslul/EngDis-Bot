import 'dotenv/config';
import figlet from "figlet";
import PromptSync from "prompt-sync";
import EngDis from "./lib/engdis.lib.js";

const prompt = PromptSync({ sigint: true });

class Main {
  engdis = new EngDis();
  isToeic = false;

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
        
        const progress = this.isToeic ? ["(Revisa tu portal TOEIC)", "N/A"] : await this.engdis.getProgress();
        
        console.log("\n========================================");
        console.log("[#] PROCESO COMPLETADO CON ÉXITO");
        console.log(`[#] Progreso final: ${progress[0]}%`);
        console.log("========================================\n");
      }
    } catch (error) {
      console.log("\n[!] Error en el flujo principal. Verifica tu Token.");
    }
  }

  async welcome() {
    console.log(figlet.textSync("EngDis BOT"));
    console.log("[!] TOEIC God-Mode activado (Transcript Injection & Loop Patch)\n");
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

      const all = (await prompt("[?] ¿Completar todo el TOEIC (Tests incluidos)? (y/n): ")) === "y";
      return all ? res.data.map(i => ({ NodeId: i.NodeId, ParentNodeId: i.ParentNodeId, Name: i.Name })) : [];
    } else {
      this.isToeic = false;
      const res = await this.engdis.getGetDefaultCourseProgress();
      if (!res.isSuccess) throw new Error("Token expirado");

      const all = (await prompt("[?] ¿Completar todo el Basic 3? (y/n): ")) === "y";
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

      const courseId = course.ParentNodeId; // ID principal de todo el curso (vital para guardar el progreso)

      for (const unit of tree.data) {
        console.log(`\n[*] Lección: ${unit.Name}`);
        
        // Obtenemos el código base y la transcripción UNA SOLA VEZ por lección
        const lessonCode = unit["Metadata"] ? unit["Metadata"]["Code"] : null;
        let transcript = "";
        
        if (this.isToeic && lessonCode) {
          transcript = await this.engdis.getTranscript(lessonCode);
          if (transcript) console.log(`    [#] Transcripción interceptada para toda la lección.`);
        }
        
        for (const section of unit.Children) {
          if (section.Name !== "Test") {
            console.log(`  [>] Completando: ${section.Name}`);
            for (const task of section.Children) {
              await this.engdis.setSucessTask(courseId, task.NodeId);
            }
          } else {
            console.log(`  [!] Iniciando Oráculo para el Test (Múltiples Partes)...`);
            if (!lessonCode) continue;

            // EL ARREGLO CRÍTICO: Iteramos por las sub-tareas del Test (t01, t02, t03...)
            for (const task of section.Children) {
              // Obtenemos el código exacto de la tarea (ej. i3lbaht01)
              const taskCode = task.Metadata?.Code ? task.Metadata.Code : lessonCode;
              
              if (this.isToeic) {
                await this.setToeicTestAI(taskCode, task.NodeId, courseId, transcript);
              } else {
                await this.setBasicTestAI(taskCode, task.NodeId, courseId);
              }
            }
          }
        }
      }
    }
  }

  // ==========================================
  //      RESOLUTOR PARA BASIC 3 (ESTÁNDAR)
  // ==========================================
  async setBasicTestAI(code, nodeId, courseId) {
    try {
      await this.engdis.setSucessTask(courseId, nodeId); 
      await new Promise(r => setTimeout(r, 1000));

      const res = await this.engdis.getTestItem(code, nodeId, courseId);
      if (!res.isSuccess) return;

      const item = res.data.i || res.data.item || res.data;
      const questions = item.q || item.questions;
      const submitAnswer = [];

      for (const q of questions) {
        const rawQuestion = (typeof q.t === 'string' ? q.t : null) || q.d || "Context task";
        const preguntaTexto = rawQuestion.toString().replace(/<[^>]*>?/gm, '').trim();
        
        const options = q.al[0].a.map(opt => ({
          id: opt.id,
          text: (opt.t || "").toString().replace(/<[^>]*>?/gm, '').trim()
        }));

        const idCorrecto = await this.engdis.consultarIA(preguntaTexto, options);
        this.procesarRespuestaIA(idCorrecto, options, item, q, submitAnswer);
        await new Promise(r => setTimeout(r, 1500));
      }

      const status = await this.engdis.SaveUserTestV1(nodeId, courseId, submitAnswer);
      console.log(`    [#] Parte ${code} -> ${status.data?.finalMark ? status.data.finalMark + "%" : "Enviada"}`);
    } catch (e) {
      console.log(`    [!] Error en Parte ${code}:`, e.message);
    }
  }

  // ==========================================
  //      RESOLUTOR PARA TOEIC (AVANZADO)
  // ==========================================
  async setToeicTestAI(code, nodeId, courseId, transcript) {
    try {
      await this.engdis.setSucessTask(courseId, nodeId); 
      await new Promise(r => setTimeout(r, 1000));

      const res = await this.engdis.getTestItem(code, nodeId, courseId);
      if (!res.isSuccess) return;

      const item = res.data.i || res.data.item || res.data;
      const questions = item.q || item.questions;
      const submitAnswer = [];

      for (const q of questions) {
        const rawQuestion = q.qt || q.d || "TOEIC Audio Context";
        const preguntaTexto = rawQuestion.toString().replace(/<[^>]*>?/gm, '').trim();
        
        const options = q.al[0].a.map(opt => ({
          id: opt.id,
          text: (opt.txt || "").toString().replace(/<[^>]*>?/gm, '').trim()
        }));

        const idCorrecto = await this.engdis.consultarIA(preguntaTexto, options, transcript);
        this.procesarRespuestaIA(idCorrecto, options, item, q, submitAnswer);
        
        await new Promise(r => setTimeout(r, 1500));
      }

      const status = await this.engdis.SaveUserTestV1(nodeId, courseId, submitAnswer);
      console.log(`    [#] Parte ${code} -> ${status.data?.finalMark ? status.data.finalMark + "%" : "Enviada"}`);
    } catch (e) {
      console.log(`    [!] Error en Parte ${code}:`, e.message);
    }
  }

  // ==========================================
  //  FUNCION AUXILIAR (EL FILTRO DE IA)
  // ==========================================
  procesarRespuestaIA(idCorrecto, options, item, q, submitAnswer) {
    let finalAnswerId = options[0].id; // Fallback por defecto si todo falla

    if (idCorrecto) {
      // Usamos Expresión Regular para buscar dígitos numéricos dentro de la respuesta
      const match = idCorrecto.match(/\d+/); 
      if (match) {
        const parsedId = parseInt(match[0], 10);
        // Verificamos que el número que sacó exista realmente en las opciones
        if (options.some(o => o.id === parsedId)) {
          finalAnswerId = parsedId;
        }
      }
    }

    submitAnswer.push({
      iId: item.id, iCode: item.c, iType: item.t || 1,
      ua: [{ qId: q.id, aId: [[q.al[0].id, finalAnswerId]] }]
    });
    
    console.log(`      [-] Pregunta procesada. ID elegido: ${finalAnswerId}`);
  }
}

(async () => {
  const main = new Main();
  main.main();
})();