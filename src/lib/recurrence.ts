import type { RecurringHabit } from "./native";

export function habitOccursOn(habit: RecurringHabit, date: string) {
  if (habit.status !== "active" || date < habit.startDate) return false;
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (habit.pattern === "daily") return true;
  if (habit.pattern === "weekdays") return weekday >= 1 && weekday <= 5;
  return habit.weekdays.includes(weekday);
}

export function habitDatesBetween(habit: RecurringHabit, startDate: string, endDate: string) {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    if (habitOccursOn(habit, date)) dates.push(date);
  }
  return dates;
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + amount);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}
