import type { Schema, Struct } from '@strapi/strapi';

export interface ChapterCityPassage extends Struct.ComponentSchema {
  collectionName: 'components_chapter_city_passages';
  info: {
    description: "Ville travers\u00E9e dans l'ordre canonique du chapitre";
    displayName: 'Passage de ville';
    icon: 'pinMap';
  };
  attributes: {
    city: Schema.Attribute.Relation<'manyToOne', 'api::city.city'> &
      Schema.Attribute.Required;
    featured: Schema.Attribute.Boolean &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<false>;
    note: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 300;
      }>;
    role: Schema.Attribute.Enumeration<['start', 'intermediate', 'end']> &
      Schema.Attribute.Required;
  };
}

export interface ChapterDestination extends Struct.ComponentSchema {
  collectionName: 'components_chapter_destinations';
  info: {
    description: "Suggestions touristiques pour la ville d'arriv\u00E9e du chapitre";
    displayName: 'Destination';
    icon: 'map-pin';
    name: 'Destination';
  };
  attributes: {
    description: Schema.Attribute.RichText;
    pois: Schema.Attribute.Component<'chapter.point-of-interest', true>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'Que visiter'>;
  };
}

export interface ChapterPointOfInterest extends Struct.ComponentSchema {
  collectionName: 'components_chapter_point_of_interests';
  info: {
    description: 'Un lieu touristique sugg\u00E9r\u00E9';
    displayName: 'Point of Interest';
    icon: 'star';
    name: 'PointOfInterest';
  };
  attributes: {
    description: Schema.Attribute.Text & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    photo: Schema.Attribute.Media<'images'>;
    url: Schema.Attribute.String;
  };
}

export interface HomepageEncounterCard extends Struct.ComponentSchema {
  collectionName: 'components_homepage_encounter_cards';
  info: {
    displayName: 'encounterCard';
    icon: 'emotionHappy';
  };
  attributes: {
    borderColor: Schema.Attribute.Enumeration<
      ['bleu', 'vert', 'rouge', 'jaune', 'beige']
    >;
    description: Schema.Attribute.RichText;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    title: Schema.Attribute.String;
  };
}

export interface HomepageFaqItem extends Struct.ComponentSchema {
  collectionName: 'components_homepage_faq_items';
  info: {
    displayName: 'FAQ Item';
    icon: 'question';
  };
  attributes: {
    answer: Schema.Attribute.Text & Schema.Attribute.Required;
    question: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface HomepageHorizonCard extends Struct.ComponentSchema {
  collectionName: 'components_homepage_horizon_cards';
  info: {
    displayName: 'Horizon Card';
    icon: 'landscape';
  };
  attributes: {
    borderColor: Schema.Attribute.Enumeration<
      ['bleu', 'vert', 'rouge', 'jaune', 'beige']
    >;
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    title: Schema.Attribute.String;
  };
}

export interface HomepagePrincipleCard extends Struct.ComponentSchema {
  collectionName: 'components_homepage_principle_cards';
  info: {
    description: 'A principle card with title, description and background color';
    displayName: 'Principle Card';
  };
  attributes: {
    backgroundColor: Schema.Attribute.Enumeration<
      ['charbon', 'jaune', 'beige', 'bleu', 'vert', 'rouge']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'beige'>;
    description: Schema.Attribute.Text & Schema.Attribute.Required;
    textColor: Schema.Attribute.Enumeration<['charbon', 'creme']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'charbon'>;
    title: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface SharedMedia extends Struct.ComponentSchema {
  collectionName: 'components_shared_media';
  info: {
    displayName: 'Media';
    icon: 'file-video';
  };
  attributes: {
    file: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
  };
}

export interface SharedQuote extends Struct.ComponentSchema {
  collectionName: 'components_shared_quotes';
  info: {
    displayName: 'Quote';
    icon: 'indent';
  };
  attributes: {
    body: Schema.Attribute.Text;
    title: Schema.Attribute.String;
  };
}

export interface SharedRichText extends Struct.ComponentSchema {
  collectionName: 'components_shared_rich_texts';
  info: {
    description: '';
    displayName: 'Rich text';
    icon: 'align-justify';
  };
  attributes: {
    body: Schema.Attribute.RichText;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    description: '';
    displayName: 'Seo';
    icon: 'allergies';
    name: 'Seo';
  };
  attributes: {
    metaDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    metaTitle: Schema.Attribute.String & Schema.Attribute.Required;
    shareImage: Schema.Attribute.Media<'images'>;
  };
}

export interface SharedSlider extends Struct.ComponentSchema {
  collectionName: 'components_shared_sliders';
  info: {
    description: '';
    displayName: 'Slider';
    icon: 'address-book';
  };
  attributes: {
    files: Schema.Attribute.Media<'images', true>;
  };
}

export interface SharedSocialLink extends Struct.ComponentSchema {
  collectionName: 'components_shared_social_links';
  info: {
    description: 'A social media or external link';
    displayName: 'Social Link';
  };
  attributes: {
    label: Schema.Attribute.String & Schema.Attribute.Required;
    platform: Schema.Attribute.String & Schema.Attribute.Required;
    url: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface SharedTestimonial extends Struct.ComponentSchema {
  collectionName: 'components_shared_testimonials';
  info: {
    description: 'A short testimonial or quote';
    displayName: 'Testimonial';
  };
  attributes: {
    author: Schema.Attribute.String & Schema.Attribute.Required;
    borderColor: Schema.Attribute.Enumeration<
      ['bleu', 'vert', 'rouge', 'jaune', 'beige']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'jaune'>;
    photo: Schema.Attribute.Media<'images'>;
    quote: Schema.Attribute.Text & Schema.Attribute.Required;
  };
}

declare module '@strapi/strapi' {
  export namespace Public {
    export interface ComponentSchemas {
      'chapter.city-passage': ChapterCityPassage;
      'chapter.destination': ChapterDestination;
      'chapter.point-of-interest': ChapterPointOfInterest;
      'homepage.encounter-card': HomepageEncounterCard;
      'homepage.faq-item': HomepageFaqItem;
      'homepage.horizon-card': HomepageHorizonCard;
      'homepage.principle-card': HomepagePrincipleCard;
      'shared.media': SharedMedia;
      'shared.quote': SharedQuote;
      'shared.rich-text': SharedRichText;
      'shared.seo': SharedSeo;
      'shared.slider': SharedSlider;
      'shared.social-link': SharedSocialLink;
      'shared.testimonial': SharedTestimonial;
    }
  }
}
