/**
 * Русские подписи стандартных колонок BPMSoft/Creatio.
 *
 * Штатный источник подписей — `SysEntitySchemaColumn` / `VwSysEntitySchemaColumn`,
 * но на части стендов эти представления недоступны (проверено на bpm9: обе дают
 * 404, в EDMX нет ни `Annotation`, ни `Caption`). Без подписей запрос вида
 * {"field": "Город"} не разрешается ничем, и модель вынуждена угадывать
 * английское имя колонки.
 *
 * Таблица закрывает распространённые колонки типовых объектов. Она не заменяет
 * подписи с сервера: `MetadataManager.resolveFieldReference` сначала пробует имя
 * и caption из схемы, и только потом — этот словарь, сверяя кандидатов с
 * реальным набором колонок коллекции.
 */

/** Нормализация ключа: регистр, ё→е, схлопывание пробелов и дефисов. */
export function normalizeAliasKey(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Подпись → возможные имена колонок, в порядке предпочтения.
 * Кандидат попадает в ответ только если такая колонка есть в схеме коллекции.
 */
const ALIASES: Record<string, string[]> = {
  // Идентификация
  название: ['Name', 'Title', 'Caption'],
  наименование: ['Name', 'Title', 'Caption'],
  имя: ['Name', 'GivenName', 'Title'],
  фамилия: ['Surname', 'LastName'],
  отчество: ['MiddleName'],
  'полное имя': ['FullName', 'Name'],
  заголовок: ['Title', 'Subject', 'Caption'],
  тема: ['Subject', 'Title'],
  код: ['Code', 'Number'],
  номер: ['Number', 'Code'],

  // Служебные
  'дата создания': ['CreatedOn'],
  создано: ['CreatedOn'],
  'кем создано': ['CreatedById'],
  'дата изменения': ['ModifiedOn'],
  изменено: ['ModifiedOn'],
  'кем изменено': ['ModifiedById'],
  ответственный: ['OwnerId'],
  владелец: ['OwnerId'],
  автор: ['AuthorId', 'CreatedById'],

  // Связи
  контрагент: ['AccountId'],
  компания: ['AccountId'],
  организация: ['AccountId'],
  контакт: ['ContactId'],
  клиент: ['AccountId', 'ContactId'],
  родитель: ['ParentId'],

  // Классификаторы
  тип: ['TypeId'],
  вид: ['TypeId', 'KindId'],
  статус: ['StatusId', 'StateId'],
  состояние: ['StatusId', 'StateId'],
  категория: ['CategoryId'],
  стадия: ['StageId'],
  приоритет: ['PriorityId'],
  результат: ['ResultId', 'Result'],
  причина: ['ReasonId'],
  источник: ['SourceId', 'LeadSourceId'],
  валюта: ['CurrencyId'],
  язык: ['LanguageId'],
  пол: ['GenderId'],
  должность: ['JobId', 'JobTitle'],
  отдел: ['DepartmentId'],
  подразделение: ['DepartmentId'],
  роль: ['RoleId', 'DecisionRoleId'],

  // География
  город: ['CityId'],
  страна: ['CountryId'],
  регион: ['RegionId'],
  область: ['RegionId'],
  адрес: ['Address'],
  индекс: ['Zip'],
  'почтовый индекс': ['Zip'],

  // Контактные данные
  телефон: ['Phone', 'MobilePhone', 'HomePhone'],
  'мобильный телефон': ['MobilePhone'],
  мобильный: ['MobilePhone'],
  почта: ['Email'],
  'электронная почта': ['Email'],
  email: ['Email'],
  сайт: ['Web'],
  вебсайт: ['Web'],

  // Тексты и числа
  описание: ['Description', 'Notes'],
  примечание: ['Notes', 'Description'],
  комментарий: ['Comment', 'Notes'],
  сумма: ['Amount', 'PrimaryAmount'],
  количество: ['Quantity'],
  цена: ['Price'],
  вероятность: ['Probability'],
  активен: ['Active'],
  активно: ['Active'],

  // Даты
  'дата начала': ['StartDate', 'DateFrom'],
  'дата завершения': ['DueDate', 'EndDate', 'DateTo'],
  'дата окончания': ['DueDate', 'EndDate', 'DateTo'],
  срок: ['DueDate'],
  'дата рождения': ['BirthDate'],
  дата: ['Date', 'StartDate', 'CreatedOn'],
};

/**
 * Кандидаты имён колонок по русской подписи. Пустой массив — подписи не знаем.
 * Проверять существование колонки — задача вызывающей стороны.
 */
export function aliasCandidates(query: string): string[] {
  const key = normalizeAliasKey(query);
  const exact = ALIASES[key];
  if (exact) return exact;

  // «Дата создания записи» → пробуем самую длинную известную подпись внутри строки.
  let best: string[] | undefined;
  let bestLength = 0;
  for (const [alias, candidates] of Object.entries(ALIASES)) {
    if (alias.length > bestLength && (key.startsWith(`${alias} `) || key.endsWith(` ${alias}`))) {
      best = candidates;
      bestLength = alias.length;
    }
  }
  return best ?? [];
}
