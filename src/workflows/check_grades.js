import { WorkflowEntrypoint } from "cloudflare:workers";
import { sendNotifierMessage } from "../backend/notifications/notifier.js";

export class CheckGradesWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    
    try {
      // Récupérer les nouvelles notes via ed-client-worker (service binding)
      const newGrades = await step.do("fetch-new-grades", async () => {
        if (!env.ED_CLIENT) throw new Error("ED_CLIENT service binding is not configured");
        const res = await env.ED_CLIENT.fetch(new Request("https://ed.internal/new-grades", {
          headers: { "filter": "true", "new_token": "false" }
        }));
        if (!res.ok) throw new Error(`ed-client-worker error (${res.status})`);
        return await res.json();
      });

      // ÉcoleDirecte demands the 2FA questionnaire — only the client can answer it.
      if (newGrades?.qcm_required) {
        return { success: true, skipped: "qcm_required" };
      }

      // Vérifier s'il y a des nouvelles notes et envoyer des notifications
      if (newGrades && typeof newGrades === "object" && Object.keys(newGrades).length > 0) {
        await step.do("send-notifications", async () => {
          for (const [periode, matieres] of Object.entries(newGrades)) {
            for (const [matiere, notes] of Object.entries(matieres)) {
              if (Array.isArray(notes) && notes.length > 0) {
                // Préparer les informations des notes
                const gradeTexts = notes.map(note => {
                  const noteValue = note.note;
                  const maxValue = note.noteSur || "20";
                  return `${noteValue}/${maxValue}`;
                }).join(", ");
                
                const gradeBrief = notes.length === 1 ? "New grade" : "New grades";
                
                // Envoyer la notification — un échec ne doit pas empêcher
                // les notifications des matières suivantes.
                try {
                  await sendNotifierMessage(env, {
                    title: `${gradeBrief} in ${matiere}`,
                    message: `${gradeBrief}: ${gradeTexts} in ${matiere} (Period: ${periode})`
                  });
                } catch (notifyError) {
                  console.error(`Notifier failed for ${matiere}:`, notifyError);
                }
              }
            }
          }
        });
      }
      
      return { success: true };
    } catch (error) {
      console.error("Error in CheckGradesWorkflow:", error);
      return { success: false, error: error.message };
    }
  }
}
