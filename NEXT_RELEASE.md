# הגרסה הבאה של drongallery-worker

המסמך מרכז שינויים שצריך להכין **לפני** הגרסה הבאה. כשסעיף מתבצע בקוד, מסמנים אותו כאן.

## מצב התלויות

**ב-2026-10-29** נסרק ישירות מ-GitHub (`npm audit --package-lock-only --omit=dev`): **0 חשיפות.** אין כרגע מה לתקן בתלויות.

הריפו **ציבורי**, ולכן כל מה שנכנס אליו גלוי לכולם: לפני כל קומיט לוודא שאין בו סודות, מפתחות או כתובות פנימיות. Secret scanning ו-push protection כבר מופעלים בו.

## הפעלת Dependabot Alerts (אחרי עדכון התלויות)

להפעיל בריפו הזה **אחרי** שמעדכנים את התלויות, כדי שלא יישלחו מיילים על חולשות שכבר ידועות: GitHub ← Settings ← Code security ← Dependabot alerts ← Enable. סוגי התלויות כאן: npm.

ה-Security Manager (yechielalaluf.com/security-manager) יציג את ההתראות אוטומטית ברגע שהן מופעלות, בתנאי שמוגדר הטוקן `GITHUB_ALERTS_TOKEN` בפרויקט my-site ב-Vercel (הוראות בראש `src/lib/githubAlerts.js` בריפו MySite).

<!-- owasp-baseline -->
## CI: OWASP baseline

נוסף `.github/workflows/owasp-baseline.yml` (2026-10-29). הוא רץ בכל push, ב-pull request, ובכל יום שני בבוקר:

- **Trivy:** תלויות פגיעות (חוסם על HIGH ו-CRITICAL שיש להן תיקון), סודות שנכנסו לקוד, והגדרות לא מאובטחות.
- **Semgrep:** ניתוח סטטי עם חוקי OWASP Top 10 (חוסם על חומרה ERROR).

ה-Actions נעולים ל-SHA מלא. ממצא שהוא סיכון מקובל נרשם בקובץ `.trivyignore` עם הסבר, ולא מחלישים את ה-workflow.

**מגבלת הסריקה:** הריפו ציבורי.

## הפעלת Dependabot Alerts (אחרי עדכון התלויות)

להפעיל בריפו הזה **אחרי** שמעדכנים את התלויות, כדי שלא יישלחו מיילים על חולשות שכבר ידועות: GitHub ← Settings ← Code security ← Dependabot alerts ← Enable. סוגי התלויות כאן: npm.

ה-Security Manager (yechielalaluf.com/security-manager) יציג את ההתראות אוטומטית ברגע שהן מופעלות, בתנאי שמוגדר הטוקן `GITHUB_ALERTS_TOKEN` בפרויקט my-site ב-Vercel (הוראות בראש `src/lib/githubAlerts.js` בריפו MySite).

<!-- asvs-audit -->
## ביקורת אבטחה לפי OWASP ASVS (טרם בוצעה)

הריפו הזה עדיין לא נבדק מול ASVS (ב-Security Manager הוא מופיע כ"לא נבדק ב-ASVS"). הביקורת תבוצע בעת העבודה על הריפו, ולא בגרסה אחת. **עדיפות מוצעת: נמוכה.**

**למה זה חשוב כאן:**

- כלי או מוצר בלי אתר ציבורי (פנימי, שולחני או נייד), ולכן הסיכון תלוי במי מריץ אותו ובמה הוא נוגע
- הריפו ציבורי, ולכן כל מה שנכנס אליו גלוי לכולם

**מסמכי אבטחה שכבר קיימים בריפו:** אין.

**איך מבצעים:**

1. לקבוע רמת יעד (ברירת מחדל: L3) ולהגדיר את השכבות: אתר, אפליקציית web, אפליקציה נייטיב, תשתית.
2. לעבור על 14 פרקי ASVS 4.0.3 מול הקוד עצמו (קריאת קוד, לא אמון ב-README), ולסמן לכל סעיף: תקין, חלקי, חוסר, לא רלוונטי או לא ניתן לאמת, עם הערה שמפנה לקובץ ולשורה.
3. לרשום את התוצאה כמוצר חדש ב-`src/lib/securityAudit.js` בריפו MySite (id, name, domain, codeLocation, targetLevel ו-requirements), ולקשר אותו בשדה `auditId` של הריפו ב-`src/lib/securityInventory.js`.
4. להמיר כל חוסר וחלקי למשימה בקובץ הזה.

## תיקונים נוספים (להוסיף כאן כשמכינים אותם)

-
