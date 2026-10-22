// Типы организаций (как категории продавцов на Авито) и продукты продвижения. Один источник правды:
// сервер использует для проверок и цен, клиент получает через /api/config.
export const ORG_KINDS = {
  cinema: { title: 'Кинотеатр', emoji: '🎬', scenario: 'sessions', cat: 'culture', sub: 'cinema', cta: 'Добавить сеансы', hint: 'Сеансы по дням: несколько показов в день, места в зале' },
  theatre: { title: 'Театр', emoji: '🎭', scenario: 'sessions', cat: 'culture', sub: 'theatre', cta: 'Добавить спектакли', hint: 'Афиша спектаклей, места в зале, Пушкинская карта' },
  rental: { title: 'Прокат', emoji: '🚲', scenario: 'rental', cat: 'sport', sub: 'walk', cta: 'Открыть прокат по часам', hint: 'Велосипеды, сапы, коньки, сноуборды: N единиц по часам' },
  resort: { title: 'Курорт / парк', emoji: '🏔️', scenario: 'open', cat: 'sport', sub: 'walk', cta: 'Объявить сезон', hint: 'Горнолыжка, пляж, парк: сезон, часы работы, что открыто', season: true },
  club: { title: 'Клуб / бар', emoji: '🎧', scenario: 'single', cat: 'music', sub: 'party', cta: 'Добавить вечеринку', hint: 'Вечеринки, концерты, квизы, караоке' },
  studio: { title: 'Студия / школа', emoji: '🧘', scenario: 'regular', cat: 'sport', sub: 'yoga', cta: 'Добавить расписание занятий', hint: 'Регулярные занятия по дням недели, пробные уроки' },
  museum: { title: 'Музей / галерея', emoji: '🏛️', scenario: 'open', cat: 'culture', sub: 'exhibition', cta: 'Добавить выставку', hint: 'Часы работы, выставки, экскурсии' },
  sport: { title: 'Спортплощадка', emoji: '⚽', scenario: 'rental', cat: 'sport', sub: 'team', cta: 'Открыть аренду', hint: 'Залы, корты, поля по часам' },
  kids: { title: 'Детская студия / кружок', emoji: '🎈', scenario: 'regular', cat: 'kids', sub: 'kidsedu', cta: 'Добавить расписание занятий', hint: 'Кружки, секции, мастер-классы и спектакли для детей: расписание, возраст, пробные занятия' },
  fun: { title: 'Развлечения', emoji: '🎢', scenario: 'sessions', cat: 'fun', sub: 'quest', cta: 'Добавить сеансы и слоты', hint: 'VR, квесты, батуты, боулинг, цирк, теплоходы: слоты и сеансы по дням' },
  community: { title: 'Сообщество / организатор', emoji: '🎪', scenario: 'single', cat: 'social', sub: 'newcomers', cta: 'Добавить событие', hint: 'Встречи, клубы, лекции, прогулки' },
};

// Цены за день, демо-баланс начисляется каждой организации для пробы.
export const PROMO_PRODUCTS = {
  event: { title: 'Поднять событие', price: 300, desc: 'Событие выше в ленте своего дня и в поиске, метка «Реклама»' },
  series: { title: 'Поднять серию или все сеансы', price: 500, desc: 'Все сеансы фильма, спектакля или занятия выше в выдаче' },
  org: { title: 'Продвигать организацию', price: 900, desc: 'Все события организации выше; карточка с меткой «Реклама» в тематических запросах' },
  boost: { title: 'Слова-магниты', price: 200, desc: 'До 5 слов: когда они есть в запросе, событие поднимается без метки «Реклама»' },
};
export const DEMO_BALANCE = 5000;
