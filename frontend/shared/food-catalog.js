// Offline/demo defaults. Signed-in sessions prefer the Supabase foods table.
export const FALLBACK_FOODS = [
  {
    "id": "spinach",
    "name": "Baby spinach",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "5 oz",
    "default_servings": 4.0,
    "shelf_life_days": 6.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "spinach",
      "spin",
      "org spin",
      "baby spinach",
      "spnch"
    ]
  },
  {
    "id": "mushrooms",
    "name": "Cremini mushrooms",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "8 oz",
    "default_servings": 4.0,
    "shelf_life_days": 7.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "mushrooms",
      "mushroom",
      "mush",
      "mush crm",
      "cremini",
      "shrooms",
      "portobello"
    ]
  },
  {
    "id": "tomatoes",
    "name": "Roma tomatoes",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "5 whole",
    "default_servings": 5.0,
    "shelf_life_days": 8.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "tomatoes",
      "tomato",
      "tom",
      "tom roma",
      "roma",
      "tomatos"
    ]
  },
  {
    "id": "garlic",
    "name": "Garlic",
    "category": "produce",
    "storage": "pantry",
    "default_unit": "1 head",
    "default_servings": 12.0,
    "shelf_life_days": 60.0,
    "default_daily_rate": 0.3,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "garlic",
      "grlc",
      "garlic clove",
      "garlic cloves",
      "minced garlic",
      "gnc garlic"
    ]
  },
  {
    "id": "onion",
    "name": "Yellow onion",
    "category": "produce",
    "storage": "pantry",
    "default_unit": "3 whole",
    "default_servings": 9.0,
    "shelf_life_days": 30.0,
    "default_daily_rate": 0.3,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "onion",
      "onions",
      "yellow onion",
      "ynon",
      "red onion"
    ]
  },
  {
    "id": "scallions",
    "name": "Scallions",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "1 bunch",
    "default_servings": 6.0,
    "shelf_life_days": 8.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "scallions",
      "scallion",
      "green onion",
      "green onions",
      "spring onion"
    ]
  },
  {
    "id": "lemon",
    "name": "Lemon",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "2 whole",
    "default_servings": 4.0,
    "shelf_life_days": 21.0,
    "default_daily_rate": 0.1,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "lemon",
      "lemons",
      "lmn"
    ]
  },
  {
    "id": "parsley",
    "name": "Parsley",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "1 bunch",
    "default_servings": 4.0,
    "shelf_life_days": 7.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "parsley",
      "prsly",
      "flat leaf parsley",
      "italian parsley"
    ]
  },
  {
    "id": "basil",
    "name": "Basil",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "1 bunch",
    "default_servings": 4.0,
    "shelf_life_days": 6.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "basil",
      "bsl",
      "fresh basil"
    ]
  },
  {
    "id": "bell-pepper",
    "name": "Bell pepper",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "2 whole",
    "default_servings": 4.0,
    "shelf_life_days": 12.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "bell pepper",
      "pepper",
      "bell",
      "red pepper",
      "green pepper",
      "capsicum"
    ]
  },
  {
    "id": "potato",
    "name": "Potatoes",
    "category": "produce",
    "storage": "pantry",
    "default_unit": "5 whole",
    "default_servings": 10.0,
    "shelf_life_days": 30.0,
    "default_daily_rate": 0.4,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "potato",
      "potatoes",
      "russet",
      "pot",
      "yukon"
    ]
  },
  {
    "id": "carrot",
    "name": "Carrots",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "1 lb",
    "default_servings": 8.0,
    "shelf_life_days": 21.0,
    "default_daily_rate": 0.2,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "carrot",
      "carrots",
      "crrt",
      "baby carrots"
    ]
  },
  {
    "id": "avocado",
    "name": "Avocado",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "2 whole",
    "default_servings": 4.0,
    "shelf_life_days": 5.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "avocado",
      "avo",
      "avos",
      "hass avocado"
    ]
  },
  {
    "id": "lime",
    "name": "Lime",
    "category": "produce",
    "storage": "fridge",
    "default_unit": "3 whole",
    "default_servings": 6.0,
    "shelf_life_days": 18.0,
    "default_daily_rate": 0.1,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "lime",
      "limes"
    ]
  },
  {
    "id": "milk",
    "name": "Whole milk",
    "category": "dairy-eggs",
    "storage": "fridge",
    "default_unit": "1 gal",
    "default_servings": 16.0,
    "shelf_life_days": 10.0,
    "default_daily_rate": 1.0,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "milk",
      "mlk",
      "gv mlk",
      "whole milk",
      "1gal",
      "2% milk",
      "skim milk"
    ]
  },
  {
    "id": "eggs",
    "name": "Large eggs",
    "category": "dairy-eggs",
    "storage": "fridge",
    "default_unit": "12 ct",
    "default_servings": 12.0,
    "shelf_life_days": 28.0,
    "default_daily_rate": 0.5,
    "item_type": "continuous",
    "checkin_style": "count",
    "count_unit": "eggs",
    "aliases": [
      "eggs",
      "egg",
      "eggs lg",
      "large eggs",
      "dozen eggs",
      "egg 12ct"
    ]
  },
  {
    "id": "parmesan",
    "name": "Parmesan",
    "category": "dairy-eggs",
    "storage": "fridge",
    "default_unit": "8 oz",
    "default_servings": 8.0,
    "shelf_life_days": 45.0,
    "default_daily_rate": 0.2,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "parmesan",
      "parm",
      "parmigiano",
      "grated parm",
      "pecorino"
    ]
  },
  {
    "id": "cheddar",
    "name": "Cheddar",
    "category": "dairy-eggs",
    "storage": "fridge",
    "default_unit": "8 oz",
    "default_servings": 8.0,
    "shelf_life_days": 40.0,
    "default_daily_rate": 0.3,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "cheddar",
      "chdr",
      "sharp cheddar",
      "cheese"
    ]
  },
  {
    "id": "butter",
    "name": "Butter",
    "category": "dairy-eggs",
    "storage": "fridge",
    "default_unit": "1 lb",
    "default_servings": 32.0,
    "shelf_life_days": 60.0,
    "default_daily_rate": 0.5,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "butter",
      "bttr",
      "unsalted butter"
    ]
  },
  {
    "id": "yogurt",
    "name": "Greek yogurt",
    "category": "dairy-eggs",
    "storage": "fridge",
    "default_unit": "32 oz",
    "default_servings": 8.0,
    "shelf_life_days": 21.0,
    "default_daily_rate": 0.6,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "yogurt",
      "yoghurt",
      "greek yogurt",
      "ygrt"
    ]
  },
  {
    "id": "cream",
    "name": "Heavy cream",
    "category": "dairy-eggs",
    "storage": "fridge",
    "default_unit": "16 oz",
    "default_servings": 8.0,
    "shelf_life_days": 14.0,
    "default_daily_rate": 0.2,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "cream",
      "heavy cream",
      "hvy crm",
      "whipping cream"
    ]
  },
  {
    "id": "chicken",
    "name": "Chicken breast",
    "category": "meat-seafood",
    "storage": "fridge",
    "default_unit": "1 lb",
    "default_servings": 4.0,
    "shelf_life_days": 3.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "chicken",
      "chkn",
      "chicken breast",
      "chix",
      "boneless chicken"
    ]
  },
  {
    "id": "ground-beef",
    "name": "Ground beef",
    "category": "meat-seafood",
    "storage": "fridge",
    "default_unit": "1 lb",
    "default_servings": 4.0,
    "shelf_life_days": 3.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "ground beef",
      "beef",
      "grnd beef",
      "hamburger",
      "80/20"
    ]
  },
  {
    "id": "bacon",
    "name": "Bacon",
    "category": "meat-seafood",
    "storage": "fridge",
    "default_unit": "12 oz",
    "default_servings": 8.0,
    "shelf_life_days": 10.0,
    "default_daily_rate": 0.3,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "bacon",
      "bcn",
      "smoked bacon"
    ]
  },
  {
    "id": "tofu",
    "name": "Firm tofu",
    "category": "meat-seafood",
    "storage": "fridge",
    "default_unit": "14 oz",
    "default_servings": 4.0,
    "shelf_life_days": 12.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "tofu",
      "firm tofu",
      "bean curd"
    ]
  },
  {
    "id": "pasta",
    "name": "Rigatoni",
    "category": "grains",
    "storage": "pantry",
    "default_unit": "16 oz",
    "default_servings": 6.0,
    "shelf_life_days": 540.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "pasta",
      "rigatoni",
      "penne",
      "spaghetti",
      "noodles",
      "macaroni"
    ]
  },
  {
    "id": "rice",
    "name": "Jasmine rice",
    "category": "grains",
    "storage": "pantry",
    "default_unit": "2 lb",
    "default_servings": 12.0,
    "shelf_life_days": 720.0,
    "default_daily_rate": 0.4,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "rice",
      "jasmine rice",
      "white rice",
      "basmati",
      "long grain"
    ]
  },
  {
    "id": "tortilla",
    "name": "Flour tortillas",
    "category": "grains",
    "storage": "pantry",
    "default_unit": "10 ct",
    "default_servings": 10.0,
    "shelf_life_days": 21.0,
    "default_daily_rate": 0.5,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "tortilla",
      "tortillas",
      "flour tortilla",
      "wraps"
    ]
  },
  {
    "id": "oats",
    "name": "Rolled oats",
    "category": "grains",
    "storage": "pantry",
    "default_unit": "18 oz",
    "default_servings": 12.0,
    "shelf_life_days": 540.0,
    "default_daily_rate": 0.5,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "oats",
      "oatmeal",
      "rolled oats",
      "old fashioned oats"
    ]
  },
  {
    "id": "sourdough",
    "name": "Sourdough",
    "category": "grains",
    "storage": "pantry",
    "default_unit": "1 loaf",
    "default_servings": 10.0,
    "shelf_life_days": 6.0,
    "default_daily_rate": 0.8,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "sourdough",
      "srdgh",
      "bread",
      "loaf",
      "boule"
    ]
  },
  {
    "id": "black-beans",
    "name": "Black beans",
    "category": "canned",
    "storage": "pantry",
    "default_unit": "15 oz can",
    "default_servings": 4.0,
    "shelf_life_days": 720.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "black beans",
      "beans",
      "blk beans",
      "canned beans"
    ]
  },
  {
    "id": "chickpeas",
    "name": "Chickpeas",
    "category": "canned",
    "storage": "pantry",
    "default_unit": "15 oz can",
    "default_servings": 4.0,
    "shelf_life_days": 720.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "chickpeas",
      "garbanzo",
      "garbanzo beans",
      "chick peas"
    ]
  },
  {
    "id": "canned-tomatoes",
    "name": "Crushed tomatoes",
    "category": "canned",
    "storage": "pantry",
    "default_unit": "28 oz can",
    "default_servings": 6.0,
    "shelf_life_days": 720.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "crushed tomatoes",
      "canned tomatoes",
      "diced tomatoes",
      "tomato sauce",
      "passata"
    ]
  },
  {
    "id": "peas",
    "name": "Frozen peas",
    "category": "frozen",
    "storage": "freezer",
    "default_unit": "16 oz",
    "default_servings": 8.0,
    "shelf_life_days": 240.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "peas",
      "frozen peas",
      "green peas",
      "sweet peas"
    ]
  },
  {
    "id": "olive-oil",
    "name": "Olive oil",
    "category": "condiments",
    "storage": "pantry",
    "default_unit": "500 ml",
    "default_servings": 60.0,
    "shelf_life_days": 540.0,
    "default_daily_rate": 0.5,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "olive oil",
      "evoo",
      "extra virgin",
      "oil"
    ]
  },
  {
    "id": "soy-sauce",
    "name": "Soy sauce",
    "category": "condiments",
    "storage": "pantry",
    "default_unit": "10 oz",
    "default_servings": 40.0,
    "shelf_life_days": 720.0,
    "default_daily_rate": 0.3,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "soy sauce",
      "soy",
      "shoyu",
      "tamari"
    ]
  },
  {
    "id": "cumin",
    "name": "Ground cumin",
    "category": "spices",
    "storage": "pantry",
    "default_unit": "2 oz",
    "default_servings": 40.0,
    "shelf_life_days": 720.0,
    "default_daily_rate": 0.1,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "cumin",
      "ground cumin",
      "cmn"
    ]
  },
  {
    "id": "chili-flakes",
    "name": "Chili flakes",
    "category": "spices",
    "storage": "pantry",
    "default_unit": "2 oz",
    "default_servings": 40.0,
    "shelf_life_days": 720.0,
    "default_daily_rate": 0.1,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "chili flakes",
      "red pepper flakes",
      "crushed red pepper",
      "chilli"
    ]
  },
  {
    "id": "flour",
    "name": "All-purpose flour",
    "category": "baking",
    "storage": "pantry",
    "default_unit": "5 lb",
    "default_servings": 40.0,
    "shelf_life_days": 365.0,
    "default_daily_rate": 0.2,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "flour",
      "ap flour",
      "all purpose flour",
      "flr"
    ]
  },
  {
    "id": "bananas",
    "name": "Bananas",
    "category": "produce",
    "storage": "pantry",
    "default_unit": "6 bananas",
    "default_servings": 6,
    "shelf_life_days": 5,
    "default_daily_rate": 0,
    "item_type": "event",
    "checkin_style": "count",
    "count_unit": "bananas",
    "aliases": [
      "banana",
      "bananas",
      "organic bananas",
      "regular bananas"
    ]
  },
  {
    "id": "spring-mix",
    "name": "Spring mix",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 4.0,
    "shelf_life_days": 4.0,
    "default_daily_rate": 0.5,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "spring mix"
    ]
  },
  {
    "id": "chicken-thighs",
    "name": "Chicken thighs",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 3.0,
    "shelf_life_days": 1.5,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "chicken thighs"
    ]
  },
  {
    "id": "cucumber",
    "name": "Cucumber",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 2.0,
    "shelf_life_days": 6.0,
    "default_daily_rate": 0.3,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "cucumber"
    ]
  },
  {
    "id": "arborio-rice",
    "name": "Arborio rice",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 6.0,
    "shelf_life_days": 365.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "arborio rice"
    ]
  },
  {
    "id": "stock",
    "name": "Stock",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 4.0,
    "shelf_life_days": 5.0,
    "default_daily_rate": 0.0,
    "item_type": "event",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "stock"
    ]
  },
  {
    "id": "olives",
    "name": "Olives",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 8.0,
    "shelf_life_days": 30.0,
    "default_daily_rate": 0.1,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "olives"
    ]
  },
  {
    "id": "paprika",
    "name": "Paprika",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 40.0,
    "shelf_life_days": 365.0,
    "default_daily_rate": 0.02,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "paprika"
    ]
  },
  {
    "id": "feta",
    "name": "Feta",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 6.0,
    "shelf_life_days": 14.0,
    "default_daily_rate": 0.2,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "feta"
    ]
  },
  {
    "id": "white-wine",
    "name": "White wine",
    "category": "other",
    "storage": "pantry",
    "default_unit": "1 package",
    "default_servings": 5.0,
    "shelf_life_days": 5.0,
    "default_daily_rate": 0.5,
    "item_type": "continuous",
    "checkin_style": "percent",
    "count_unit": null,
    "aliases": [
      "white wine"
    ]
  }
];
