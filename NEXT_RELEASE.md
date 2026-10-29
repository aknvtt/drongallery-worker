# הגרסה הבאה של drongallery-worker

המסמך מרכז שינויים שצריך להכין **לפני** הגרסה הבאה. כשסעיף מתבצע בקוד, מסמנים אותו כאן.

## מצב התלויות

**ב-2026-10-29** נסרק ישירות מ-GitHub (`npm audit --package-lock-only --omit=dev`): **0 חשיפות.** אין כרגע מה לתקן בתלויות.

הריפו **ציבורי**, ולכן כל מה שנכנס אליו גלוי לכולם: לפני כל קומיט לוודא שאין בו סודות, מפתחות או כתובות פנימיות. Secret scanning ו-push protection כבר מופעלים בו.

## הפעלת Dependabot Alerts (אחרי עדכון התלויות)

להפעיל בריפו הזה **אחרי** שמעדכנים את התלויות, כדי שלא יישלחו מיילים על חולשות שכבר ידועות: GitHub ← Settings ← Code security ← Dependabot alerts ← Enable. סוגי התלויות כאן: npm.

ה-Security Manager (yechielalaluf.com/security-manager) יציג את ההתראות אוטומטית ברגע שהן מופעלות, בתנאי שמוגדר הטוקן `GITHUB_ALERTS_TOKEN` בפרויקט my-site ב-Vercel (הוראות בראש `src/lib/githubAlerts.js` בריפו MySite).

## תיקונים נוספים (להוסיף כאן כשמכינים אותם)

-
